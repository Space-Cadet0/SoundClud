use crate::protocol::{StandbyState, TrackMetadata};

const ACT_SERVICE_URN: &str = "urn:schemas-denon-com:service:ACT:1";
const AVT_SERVICE_URN: &str = "urn:schemas-upnp-org:service:AVTransport:1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UpnpPositionInfo {
    pub rel_time_ms: u64,
    pub track_duration_ms: u64,
}

#[must_use]
pub fn xml_escape(raw: &str) -> String {
    let mut escaped = String::with_capacity(raw.len() + 16);
    for ch in raw.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

#[must_use]
pub fn xml_unescape(raw: &str) -> String {
    raw.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

#[must_use]
pub fn format_upnp_duration(ms: u64) -> String {
    let total_secs = ms / 1000;
    let hours = total_secs / 3600;
    let mins = (total_secs % 3600) / 60;
    let secs = total_secs % 60;
    format!("{hours:02}:{mins:02}:{secs:02}")
}

#[must_use]
pub fn parse_upnp_duration_ms(raw: &str) -> Option<u64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("NOT_IMPLEMENTED") {
        return None;
    }
    let parts: Vec<&str> = trimmed.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let hours = parts[0].parse::<u64>().ok()?;
    let mins = parts[1].parse::<u64>().ok()?;
    let secs_f = parts[2].parse::<f64>().ok()?;
    if !secs_f.is_finite() || secs_f < 0.0 {
        return None;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let sec_ms = (secs_f * 1000.0).round() as u64;
    Some((hours * 3_600_000) + (mins * 60_000) + sec_ms)
}

#[must_use]
pub fn extract_xml_tag_text(xml: &str, local_tag: &str) -> Option<String> {
    for prefix in ["", "u:", "s:", "dc:", "upnp:"] {
        let open = format!("<{prefix}{local_tag}");
        let close = format!("</{prefix}{local_tag}>");
        let mut search_from = 0;
        while let Some(rel_idx) = xml[search_from..].find(&open) {
            let tag_start = search_from + rel_idx;
            let after_name = tag_start + open.len();
            let next_ch = xml[after_name..].chars().next();
            if !matches!(next_ch, Some('>' | ' ' | '\t' | '\r' | '\n')) {
                search_from = after_name;
                continue;
            }
            let gt_rel = xml[after_name..].find('>')?;
            let content_start = after_name + gt_rel + 1;
            let close_rel = xml[content_start..].find(&close)?;
            let inner = &xml[content_start..content_start + close_rel];
            return Some(xml_unescape(inner.trim()));
        }
    }
    None
}

/// Builds UPnP `DIDL-Lite` XML for Denon/Marantz front-panel OLED metadata display.
#[must_use]
pub fn build_didl_lite_metadata(track: &TrackMetadata, stream_url: &str) -> String {
    let title = xml_escape(&track.title);
    let artist = xml_escape(&track.artist);
    let url_esc = xml_escape(stream_url);
    let dur = format_upnp_duration(track.duration_ms);
    let art_tag = track
        .artwork_url
        .as_deref()
        .map_or_else(String::new, |art| {
            format!("<upnp:albumArtURI>{}</upnp:albumArtURI>", xml_escape(art))
        });

    format!(
        "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" \
         xmlns:dc=\"http://purl.org/dc/elements/1.1/\" \
         xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\">\
         <item id=\"sc_{}\" parentID=\"0\" restricted=\"1\">\
         <dc:title>{title}</dc:title>\
         <upnp:artist>{artist}</upnp:artist>\
         <dc:creator>{artist}</dc:creator>\
         {art_tag}\
         <upnp:class>object.item.audioItem.musicTrack</upnp:class>\
         <res protocolInfo=\"http-get:*:audio/wav:*\" sampleFrequency=\"44100\" \
         bitsPerSample=\"24\" nrAudioChannels=\"2\" duration=\"{dur}\">{url_esc}</res>\
         </item></DIDL-Lite>",
        xml_escape(&track.track_id)
    )
}

async fn post_soap_action(
    client: &reqwest::Client,
    control_url: &str,
    service_urn: &str,
    action: &str,
    inner_args_xml: &str,
) -> Result<String, String> {
    let envelope = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\
         <s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" \
         s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">\
         <s:Body><u:{action} xmlns:u=\"{service_urn}\">{inner_args_xml}</u:{action}></s:Body>\
         </s:Envelope>"
    );
    let soap_action_hdr = format!("\"{service_urn}#{action}\"");
    let resp = client
        .post(control_url)
        .header("Content-Type", "text/xml; charset=\"utf-8\"")
        .header("SOAPACTION", soap_action_hdr)
        .body(envelope)
        .send()
        .await
        .map_err(|e| format!("SOAP {action} request failed: {e}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("SOAP {action} body read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("SOAP {action} HTTP {}", status.as_u16()));
    }
    Ok(body)
}

pub async fn get_device_power_state(
    client: &reqwest::Client,
    act_control_url: &str,
) -> Result<StandbyState, String> {
    let xml = post_soap_action(
        client,
        act_control_url,
        ACT_SERVICE_URN,
        "GetDevicePowerState",
        "",
    )
    .await?;
    match extract_xml_tag_text(&xml, "devicePower")
        .unwrap_or_default()
        .to_ascii_uppercase()
        .as_str()
    {
        "ON" => Ok(StandbyState::On),
        "OFF" | "STANDBY" => Ok(StandbyState::Off),
        _ => Ok(StandbyState::Unknown),
    }
}

pub async fn set_device_power_state_on(
    client: &reqwest::Client,
    act_control_url: &str,
) -> Result<(), String> {
    let _ = post_soap_action(
        client,
        act_control_url,
        ACT_SERVICE_URN,
        "SetDevicePowerState",
        "<devicePower>ON</devicePower>",
    )
    .await?;
    Ok(())
}

pub async fn avt_set_transport_uri(
    client: &reqwest::Client,
    avt_control_url: &str,
    stream_url: &str,
    didl_lite: &str,
) -> Result<(), String> {
    let args = format!(
        "<InstanceID>0</InstanceID><CurrentURI>{}</CurrentURI><CurrentURIMetaData>{}</CurrentURIMetaData>",
        xml_escape(stream_url),
        xml_escape(didl_lite)
    );
    let _ = post_soap_action(
        client,
        avt_control_url,
        AVT_SERVICE_URN,
        "SetAVTransportURI",
        &args,
    )
    .await?;
    Ok(())
}

pub async fn avt_play(client: &reqwest::Client, avt_control_url: &str) -> Result<(), String> {
    let _ = post_soap_action(
        client,
        avt_control_url,
        AVT_SERVICE_URN,
        "Play",
        "<InstanceID>0</InstanceID><Speed>1</Speed>",
    )
    .await?;
    Ok(())
}

pub async fn avt_pause(client: &reqwest::Client, avt_control_url: &str) -> Result<(), String> {
    let _ = post_soap_action(
        client,
        avt_control_url,
        AVT_SERVICE_URN,
        "Pause",
        "<InstanceID>0</InstanceID>",
    )
    .await?;
    Ok(())
}

pub async fn avt_stop(client: &reqwest::Client, avt_control_url: &str) -> Result<(), String> {
    let _ = post_soap_action(
        client,
        avt_control_url,
        AVT_SERVICE_URN,
        "Stop",
        "<InstanceID>0</InstanceID>",
    )
    .await?;
    Ok(())
}

pub async fn avt_seek_rel_time(
    client: &reqwest::Client,
    avt_control_url: &str,
    target_ms: u64,
) -> Result<(), String> {
    let args = format!(
        "<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>{}</Target>",
        format_upnp_duration(target_ms)
    );
    let _ = post_soap_action(client, avt_control_url, AVT_SERVICE_URN, "Seek", &args).await?;
    Ok(())
}

pub async fn avt_get_position_info(
    client: &reqwest::Client,
    avt_control_url: &str,
) -> Result<UpnpPositionInfo, String> {
    let xml = post_soap_action(
        client,
        avt_control_url,
        AVT_SERVICE_URN,
        "GetPositionInfo",
        "<InstanceID>0</InstanceID>",
    )
    .await?;
    let rel_time_ms = extract_xml_tag_text(&xml, "RelTime")
        .and_then(|s| parse_upnp_duration_ms(&s))
        .unwrap_or(0);
    let track_duration_ms = extract_xml_tag_text(&xml, "TrackDuration")
        .and_then(|s| parse_upnp_duration_ms(&s))
        .unwrap_or(0);
    Ok(UpnpPositionInfo {
        rel_time_ms,
        track_duration_ms,
    })
}

pub async fn avt_get_transport_info(
    client: &reqwest::Client,
    avt_control_url: &str,
) -> Result<String, String> {
    let xml = post_soap_action(
        client,
        avt_control_url,
        AVT_SERVICE_URN,
        "GetTransportInfo",
        "<InstanceID>0</InstanceID>",
    )
    .await?;
    Ok(extract_xml_tag_text(&xml, "CurrentTransportState").unwrap_or_default())
}
