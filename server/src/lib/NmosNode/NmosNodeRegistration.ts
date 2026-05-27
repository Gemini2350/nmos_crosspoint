/*
 * NMOS Crosspoint — IS-04 Registration Client
 *
 * Pushes the virtual Node + Device + Sources + Flows + Senders (built by
 * NmosNodeApi) to the configured NMOS registry, then keeps the Node alive
 * with periodic heartbeats. Without this, the registry would never know
 * about virtual senders even though /x-nmos/... is being served — other
 * controllers can't query a Node they were never told about.
 *
 * Lifecycle:
 *
 *   start()           — POST node → device → sources → flows → senders,
 *                       then begin the heartbeat loop.
 *   syncResources()   — re-POST every resource (used after the operator
 *                       saves a settings change so renames/SDP updates land).
 *   stop()            — DELETE the node (registry deletes its children
 *                       automatically) and stop the heartbeat. Used when
 *                       the live-registry-switch tears the old registry
 *                       down before bringing the new one up.
 *
 * The registry URL is read from settings.staticNmosRegistries[0]. We only
 * publish to that one; the rest of NMOS Crosspoint already prefers the
 * static registry over anything mDNS discovers.
 *
 * On 404 from a heartbeat we treat the Node as forgotten by the registry
 * and re-POST everything from scratch.
 */

import { NmosNodeApi } from "./NmosNodeApi";
import { SyncLog } from "../syncLog";

const axios = require("axios");

export class NmosNodeRegistration {
    public static instance: NmosNodeRegistration | null = null;

    private settings:any;
    private heartbeatTimer:any = null;
    private heartbeatMs = 5000;
    // Generation counter — bumped on stop() / settings change so a stray
    // re-POST after the registry was torn down doesn't undo the teardown.
    private gen = 0;
    private running = false;

    // IDs we last POSTed to the registry, so syncResources() can DELETE
    // entries that disappeared from settings.virtualSenders.
    private lastSenderIds: Set<string> = new Set();
    private lastFlowIds:   Set<string> = new Set();
    private lastSourceIds: Set<string> = new Set();

    constructor(settings:any){
        this.settings = settings;
        NmosNodeRegistration.instance = this;
    }

    public setSettings(settings:any){
        this.settings = settings;
    }

    /** Build the registry base URL ("http://ip:port") from settings, or "" if none. */
    private registryBase(): string {
        try{
            let list = this.settings?.staticNmosRegistries;
            if(!Array.isArray(list) || list.length === 0) return "";
            let r = list[0];
            if(!r || !r.ip || !r.port) return "";
            return "http://" + r.ip + ":" + r.port;
        }catch(e){}
        return "";
    }

    private apiBase(): string {
        let base = this.registryBase();
        return base ? (base + "/x-nmos/registration/v1.3") : "";
    }


    /** POST every resource (node first, then dependents). Idempotent — the
     *  registry treats a re-POST of an existing resource as an update.
     *
     *  When `settings.virtualNode.enabled` is false this is a no-op — the
     *  operator has explicitly disabled the virtual-node feature.
     */
    public async start(){
        if(this.running) return;
        if(this.settings?.virtualNode?.enabled === false){
            SyncLog.log("info", "NMOS Node Registration", "Virtual Node feature disabled in settings — skipping registration.");
            return;
        }
        this.running = true;
        this.gen++;
        let myGen = this.gen;
        let api = NmosNodeApi.instance;
        let url = this.apiBase();
        if(!api || !url){
            SyncLog.log("warn", "NMOS Node Registration", "No registry configured / NmosNodeApi missing — not registering.");
            this.running = false;
            return;
        }
        let resources = api.getResources();
        if(!resources.node){
            SyncLog.log("warn", "NMOS Node Registration", "No node resource built — skipping registration.");
            this.running = false;
            return;
        }

        SyncLog.log("info", "NMOS Node Registration", "Registering virtual Node + " + resources.senders.length + " sender(s) on " + url);
        try{
            await this.postResource(url, "node", resources.node);
            await this.postResource(url, "device", resources.device);
            for(let s of resources.sources) await this.postResource(url, "source", s);
            for(let f of resources.flows)   await this.postResource(url, "flow",   f);
            for(let s of resources.senders) await this.postResource(url, "sender", s);
            this.snapshotIds(resources);
        }catch(e:any){
            SyncLog.log("error", "NMOS Node Registration", "Initial registration failed: " + (e?.message || e));
            // Heartbeat-Re-Register-on-404 will pick up the slack once the
            // registry comes back; no need to crash here.
        }

        if(myGen !== this.gen) return;   // stop() was called mid-flight
        this.scheduleHeartbeat(myGen);
    }


    /** Remember which IDs we last published, so the next syncResources()
     *  can DELETE the ones that have since disappeared from settings. */
    private snapshotIds(resources:any){
        this.lastSenderIds = new Set(resources.senders.map((s:any) => s.id));
        this.lastFlowIds   = new Set(resources.flows.map((f:any) => f.id));
        this.lastSourceIds = new Set(resources.sources.map((s:any) => s.id));
    }


    /** Re-POST every resource AND DELETE any whose id has since disappeared
     *  from settings. Cheaper than a stop()+start() round-trip and is what
     *  we want when the operator added/removed/renamed a virtual sender. */
    public async syncResources(){
        if(!this.running){
            return this.start();
        }
        let api = NmosNodeApi.instance;
        let url = this.apiBase();
        if(!api || !url) return;
        let resources = api.getResources();
        if(!resources.node) return;

        let myGen = this.gen;
        try{
            // 1) DELETE resources that vanished between this sync and the
            //    last successful publication. Order matters: senders before
            //    flows before sources (children before parents).
            let nowSenders = new Set(resources.senders.map((s:any) => s.id));
            let nowFlows   = new Set(resources.flows.map((f:any) => f.id));
            let nowSources = new Set(resources.sources.map((s:any) => s.id));
            for(let id of Array.from(this.lastSenderIds)){
                if(!nowSenders.has(id)) await this.deleteResource(url, "senders", id);
            }
            for(let id of Array.from(this.lastFlowIds)){
                if(!nowFlows.has(id)) await this.deleteResource(url, "flows", id);
            }
            for(let id of Array.from(this.lastSourceIds)){
                if(!nowSources.has(id)) await this.deleteResource(url, "sources", id);
            }

            // 2) POST every currently-known resource (idempotent → update).
            await this.postResource(url, "node", resources.node);
            await this.postResource(url, "device", resources.device);
            for(let s of resources.sources) await this.postResource(url, "source", s);
            for(let f of resources.flows)   await this.postResource(url, "flow",   f);
            for(let s of resources.senders) await this.postResource(url, "sender", s);

            this.snapshotIds(resources);
            if(myGen !== this.gen) return;
            SyncLog.log("info", "NMOS Node Registration", "Re-synchronised virtual sender resources to registry.");
        }catch(e:any){
            SyncLog.log("warn", "NMOS Node Registration", "Sync failed: " + (e?.message || e));
        }
    }


    /** DELETE every resource and stop the heartbeat. Order matters: the
     *  registry rejects DELETEs of resources that still have dependents.
     *
     *  We clear the heartbeat interval BEFORE we begin DELETEing so an
     *  in-flight heartbeat tick can't 404 and re-register everything we're
     *  about to take down. The gen bump is a belt-and-braces extra check
     *  inside the timer callback.
     */
    public async stop(){
        if(!this.running) return;
        if(this.heartbeatTimer){
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        this.running = false;
        this.gen++;
        let api = NmosNodeApi.instance;
        let url = this.apiBase();
        if(!api || !url) return;
        let resources = api.getResources();

        try{
            for(let s of resources.senders) await this.deleteResource(url, "senders", s.id);
            for(let f of resources.flows)   await this.deleteResource(url, "flows",   f.id);
            for(let s of resources.sources) await this.deleteResource(url, "sources", s.id);
            if(resources.device)            await this.deleteResource(url, "devices", resources.device.id);
            if(resources.node)              await this.deleteResource(url, "nodes",   resources.node.id);
            SyncLog.log("info", "NMOS Node Registration", "Deregistered virtual Node + resources from registry.");
        }catch(e:any){
            // Most likely the registry is already gone — that's fine, the
            // resources expire on their own without a heartbeat anyway.
            SyncLog.log("verbose", "NMOS Node Registration", "Cleanup DELETE on tear-down: " + (e?.message || e));
        }
        this.lastSenderIds.clear();
        this.lastFlowIds.clear();
        this.lastSourceIds.clear();
    }


    private async postResource(url:string, type:string, data:any){
        let resp = await axios.post(url + "/resource", { type, data });
        if(resp.status !== 200 && resp.status !== 201){
            throw new Error("Unexpected status " + resp.status + " on POST /resource type=" + type);
        }
    }

    private async deleteResource(url:string, plural:string, id:string){
        try{
            await axios.delete(url + "/resource/" + plural + "/" + id);
        }catch(e:any){
            // 404 == not there, that's fine.
            if(e?.response?.status !== 404){
                throw e;
            }
        }
    }


    private scheduleHeartbeat(myGen:number){
        if(this.heartbeatTimer){ clearInterval(this.heartbeatTimer); }
        this.heartbeatTimer = setInterval(async () => {
            if(myGen !== this.gen) return;
            let api = NmosNodeApi.instance;
            let url = this.apiBase();
            if(!api || !url) return;
            let node = api.getNode();
            if(!node) return;
            try{
                await axios.post(url + "/health/nodes/" + node.id);
            }catch(e:any){
                if(myGen !== this.gen) return;  // stop() raced us — drop it
                if(e?.response?.status === 404){
                    // Registry forgot about us (restart, garbage-collect …)
                    // — re-publish everything to recover. syncResources()
                    // itself rechecks this.gen so a stop() landing between
                    // the 404 and the POSTs still wins.
                    SyncLog.log("warn", "NMOS Node Registration", "Heartbeat returned 404 — re-registering.");
                    this.syncResources().catch(()=>{});
                }
                // Any other error: just try again next tick.
            }
        }, this.heartbeatMs);
    }
}
