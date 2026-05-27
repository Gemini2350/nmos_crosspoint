/*
 * NMOS Crosspoint — SDP → IS-04 metadata mapper
 *
 * Converts a raw SDP (the one the operator pasted on the Setup page for a
 * virtual sender) into the shape IS-04 Source + Flow records expect, plus
 * the IS-05 transport_params we hand to receivers. The goal is to publish
 * virtual senders to any NMOS registry as if they were normal SMPTE 2110
 * senders — controllers and receivers should not need to know about the
 * "virtual" origin.
 *
 * Only the formats Crosspoint already understands (audio L16/L24/L32/AM824,
 * video raw / jxsv, ANC smpte291) are mapped to fully-typed records. For
 * anything else we still publish a generic flow with media_type from the SDP,
 * which is enough for receivers that just need an SDP transport file.
 */

import * as sdpTransform from "sdp-transform";

export interface ParsedVirtualSdp {
    // High-level format hint used by Source.format and Flow.format
    format: "urn:x-nmos:format:audio" | "urn:x-nmos:format:video" | "urn:x-nmos:format:data" | "urn:x-nmos:format:mux";
    // RTP media_type as it appears in Flow.media_type (e.g. "audio/L24", "video/raw")
    mediaType: string;
    // Per-leg transport_params (1 or 2 entries for ST 2022-7 redundant feeds)
    transportParams: Array<{
        source_ip:        string,
        destination_ip:   string,
        destination_port: number,
        rtp_enabled:      boolean
    }>;

    // Audio-only fields (undefined for video / data)
    audio?: {
        sampleRate: number,    // e.g. 48000
        channels:   number,    // e.g. 8
        bitDepth:   number     // 16 / 24
    };

    // Video-only fields (undefined for audio / data)
    video?: {
        width:        number,
        height:       number,
        interlace:    "progressive" | "interlaced_tff" | "interlaced_bff",
        grainRate:    { numerator: number, denominator: number },
        sampling?:    string,    // e.g. "YCbCr-4:2:2"
        depth?:       number,    // 8 / 10 / 12
        colorimetry?: string,    // e.g. "BT709"
        transferChar?:string     // e.g. "SDR"
    };
}


/**
 * Parse the raw SDP and pull every field IS-04 / IS-05 publication needs.
 * Throws when the SDP can't be parsed or has no `m=` media block — virtual
 * senders without a real media section can't be registered.
 */
export function parseVirtualSdp(rawSdp:string): ParsedVirtualSdp {
    if(typeof rawSdp !== "string" || rawSdp.trim().length === 0){
        throw new Error("empty SDP");
    }
    let sdp:any = sdpTransform.parse(rawSdp);
    if(!sdp || !Array.isArray(sdp.media) || sdp.media.length === 0){
        throw new Error("SDP has no media (m=) section");
    }

    // Per-media transport_params. ST 2022-7 redundant streams come through as
    // two separate `m=` blocks in one SDP. We treat each block as one leg.
    let transportParams = sdp.media.map((m:any, idx:number) => {
        let destIp = "";
        try{
            if(m.sourceFilter && m.sourceFilter.destAddress){
                destIp = ("" + m.sourceFilter.destAddress);
            }else if(m.connection && m.connection.ip){
                destIp = ("" + m.connection.ip).split("/")[0];
            }else if(sdp.connection && sdp.connection.ip){
                destIp = ("" + sdp.connection.ip).split("/")[0];
            }
        }catch(e){}
        if(!destIp){
            // An IS-05 transport_params entry without a destination IP is
            // useless — a receiver patched to this leg can't subscribe to
            // any multicast. Reject the whole SDP so the operator notices
            // (the sender is skipped in NmosNodeApi.rebuild and logged).
            throw new Error("media block " + (idx+1) + " has no c=/sourceFilter destination IP");
        }
        let srcIp = "";
        try{
            if(m.sourceFilter && m.sourceFilter.srcList){
                srcIp = ("" + m.sourceFilter.srcList);
            }
        }catch(e){}
        let port = (typeof m.port === "number") ? m.port : 5004;
        return {
            source_ip:        srcIp || "0.0.0.0",
            destination_ip:   destIp,
            destination_port: port,
            rtp_enabled:      true
        };
    });

    // Codec / format come from the first media block's rtp[0] entry.
    let firstMedia = sdp.media[0];
    let mediaTypeRaw = ("" + (firstMedia.type || "")).toLowerCase();      // "audio" | "video"
    let codec        = ("" + (firstMedia.rtp?.[0]?.codec || "")).toUpperCase();
    let rate         = Number(firstMedia.rtp?.[0]?.rate || 0);
    let encoding     = ("" + (firstMedia.rtp?.[0]?.encoding || "")).trim(); // for audio: channel count

    // Build the IS-04 media_type string. SDP-style "L24" → IS-04 "audio/L24".
    // SDP "raw" → "video/raw", "jxsv" → "video/jxsv", "smpte291" → "video/smpte291".
    // L32 in SDP carries 24-bit LPCM samples padded into a 32-bit container;
    // NMOS' canonical form is audio/L24, so normalise.
    let mediaType = mediaTypeRaw + "/" + codec;
    if(codec === "RAW")           mediaType = "video/raw";
    else if(codec === "JXSV")     mediaType = "video/jxsv";
    else if(codec === "SMPTE291") mediaType = "video/smpte291";
    else if(codec === "L32")      mediaType = "audio/L24";

    // ----- Audio -----
    if(mediaTypeRaw === "audio"){
        let channels = parseInt(encoding) || 2;
        let bitDepth = 24;
        if(codec === "L16")              bitDepth = 16;
        else if(codec === "L24")         bitDepth = 24;
        else if(codec === "L32")         bitDepth = 24;  // L32 is 24-bit padded into 32-bit
        else if(codec === "AM824")       bitDepth = 24;
        return {
            format: "urn:x-nmos:format:audio",
            mediaType,
            transportParams,
            audio: {
                sampleRate: rate || 48000,
                channels,
                bitDepth
            }
        };
    }

    // ----- ANC data -----
    if(codec === "SMPTE291"){
        return {
            format: "urn:x-nmos:format:data",
            mediaType: "video/smpte291",
            transportParams
        };
    }

    // ----- Video (raw, jxsv, …) -----
    if(mediaTypeRaw === "video"){
        // a=fmtp:96 sampling=YCbCr-4:2:2; width=1920; height=1080; exactframerate=25; depth=10; colorimetry=BT709; …
        let fmtp = firstMedia.fmtp?.[0]?.config || "";
        let attrs: { [k:string]: string } = {};
        fmtp.split(";").forEach((kv:string) => {
            let [k,v] = kv.split("=").map(x => (x||"").trim());
            if(k) attrs[k.toLowerCase()] = v || "";
        });
        let width  = parseInt(attrs["width"])  || 1920;
        let height = parseInt(attrs["height"]) || 1080;
        let depth  = parseInt(attrs["depth"])  || 10;

        // exactframerate is either "<num>" or "<num>/<den>"
        let grainRate = { numerator: 25, denominator: 1 };
        let fr = attrs["exactframerate"] || "";
        if(fr){
            let parts = fr.split("/").map(x => parseInt(x));
            grainRate = { numerator: parts[0] || 25, denominator: parts[1] || 1 };
        }

        // ST 2110-20 uses "interlace" attribute (present = interlaced).
        let interlace: "progressive" | "interlaced_tff" | "interlaced_bff" = "progressive";
        if(attrs.hasOwnProperty("interlace")){
            interlace = "interlaced_tff";
        }

        return {
            format: "urn:x-nmos:format:video",
            mediaType,
            transportParams,
            video: {
                width,
                height,
                interlace,
                grainRate,
                sampling:    attrs["sampling"]    || undefined,
                depth,
                colorimetry: attrs["colorimetry"] || undefined,
                transferChar:attrs["tcs"]         || undefined
            }
        };
    }

    // ----- Fallback / unknown -----
    return {
        format: "urn:x-nmos:format:mux",
        mediaType,
        transportParams
    };
}


/**
 * Build the components[] block for a raw-video Flow record (IS-04). Standard
 * 4:2:2 YCbCr with three planes; the chroma planes are half-width.
 */
export function buildVideoComponents(width:number, height:number, depth:number, sampling?:string){
    let chromaWidth = width;
    if(sampling === "YCbCr-4:2:2" || sampling === "YCbCr-4:2:0"){
        chromaWidth = Math.floor(width / 2);
    }
    let chromaHeight = height;
    if(sampling === "YCbCr-4:2:0"){
        chromaHeight = Math.floor(height / 2);
    }
    return [
        { name: "Y",  width,        height,        bit_depth: depth },
        { name: "Cb", width: chromaWidth, height: chromaHeight, bit_depth: depth },
        { name: "Cr", width: chromaWidth, height: chromaHeight, bit_depth: depth }
    ];
}
