use crate::coordinator::ReceiverCoordinator;
use crate::protocol::{
    now_timestamp_ms, ClientWsCommand, ServerWsEvent, UpdateConfigRequest, PROTOCOL_VERSION,
};
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::sync::mpsc;

pub async fn handle_ws_socket(socket: WebSocket, coord: Arc<ReceiverCoordinator>) {
    let (mut ws_sink, mut ws_stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<ServerWsEvent>();

    let writer_task = tokio::spawn(async move {
        while let Some(event) = out_rx.recv().await {
            let Ok(text) = serde_json::to_string(&event) else {
                continue;
            };
            if ws_sink.send(Message::Text(text.into())).await.is_err() {
                return;
            }
        }
        let _ = ws_sink.send(Message::Close(None)).await;
        let _ = ws_sink.close().await;
    });

    let mut registered_conn_id: Option<u64> = None;

    while let Some(Ok(msg)) = ws_stream.next().await {
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => break,
            _ => continue,
        };

        let cmd = match serde_json::from_str::<ClientWsCommand>(&text) {
            Ok(c) => c,
            Err(e) => {
                let _ = out_tx.send(ServerWsEvent::Error {
                    code: "invalid_command".to_string(),
                    message: format!("invalid ClientWsCommand JSON: {e}"),
                    command_seq: None,
                });
                continue;
            }
        };

        match cmd {
            ClientWsCommand::Ping {
                client_timestamp_ms,
            } => {
                let _ = out_tx.send(ServerWsEvent::Pong {
                    client_timestamp_ms,
                    server_timestamp_ms: now_timestamp_ms(),
                });
            }
            ClientWsCommand::Hello {
                protocol_version,
                pairing_token,
                controller_id,
                client_label,
            } => {
                if protocol_version != PROTOCOL_VERSION {
                    let _ = out_tx.send(ServerWsEvent::Error {
                        code: "unsupported_protocol".to_string(),
                        message: format!("expected protocolVersion {PROTOCOL_VERSION}"),
                        command_seq: None,
                    });
                    break;
                }
                if !coord.verify_token(&pairing_token) {
                    let _ = out_tx.send(ServerWsEvent::Error {
                        code: "unauthorized".to_string(),
                        message: "invalid or unpaired pairingToken".to_string(),
                        command_seq: None,
                    });
                    break;
                }
                if let Some(prev_id) = registered_conn_id.take() {
                    coord.unregister_ws_controller(prev_id).await;
                }
                let cid = coord.register_ws_controller(
                    controller_id.clone(),
                    client_label,
                    out_tx.clone(),
                );
                registered_conn_id = Some(cid);

                let mut outputs = coord.outputs_snapshot();
                if outputs.is_empty() {
                    outputs = coord.refresh_outputs().await;
                }
                let (receiver_id, receiver_name) = coord.receiver_identity();
                let welcome = ServerWsEvent::Welcome {
                    protocol_version: PROTOCOL_VERSION.to_string(),
                    receiver_id,
                    receiver_name,
                    controller_id,
                    config: coord.config_snapshot(),
                    telemetry: Box::new(coord.telemetry_snapshot()),
                    outputs,
                };
                let _ = out_tx.send(welcome);
            }
            other => {
                let Some(conn_id) = registered_conn_id else {
                    let seq = command_seq_of(&other);
                    let _ = out_tx.send(ServerWsEvent::Error {
                        code: "unauthorized".to_string(),
                        message: "must authenticate via hello before sending commands".to_string(),
                        command_seq: seq,
                    });
                    continue;
                };
                dispatch_authenticated_command(&coord, conn_id, other, &out_tx).await;
            }
        }
    }

    if let Some(conn_id) = registered_conn_id {
        coord.unregister_ws_controller(conn_id).await;
    }
    drop(out_tx);
    let _ = tokio::time::timeout(std::time::Duration::from_millis(500), writer_task).await;
}

const fn command_seq_of(cmd: &ClientWsCommand) -> Option<u64> {
    match cmd {
        ClientWsCommand::LoadTrack { command_seq, .. }
        | ClientWsCommand::SetPaused { command_seq, .. }
        | ClientWsCommand::Seek { command_seq, .. }
        | ClientWsCommand::PreloadNext { command_seq, .. }
        | ClientWsCommand::Stop { command_seq, .. }
        | ClientWsCommand::SelectOutput { command_seq, .. } => Some(*command_seq),
        ClientWsCommand::Hello { .. }
        | ClientWsCommand::RefreshLocatorResponse { .. }
        | ClientWsCommand::Ping { .. } => None,
    }
}

async fn dispatch_authenticated_command(
    coord: &Arc<ReceiverCoordinator>,
    conn_id: u64,
    cmd: ClientWsCommand,
    out_tx: &mpsc::UnboundedSender<ServerWsEvent>,
) {
    match cmd {
        ClientWsCommand::LoadTrack {
            command_seq,
            locator,
            preferred_output_id,
        } => {
            coord.claim_session_if_needed(conn_id);
            if let Err(msg) = coord
                .load_track(command_seq, *locator, preferred_output_id)
                .await
            {
                let _ = out_tx.send(ServerWsEvent::Error {
                    code: "load_failed".to_string(),
                    message: msg,
                    command_seq: Some(command_seq),
                });
            }
        }
        ClientWsCommand::SetPaused {
            command_seq,
            paused,
        } => {
            coord.claim_session_if_needed(conn_id);
            if let Err(msg) = coord.set_paused(command_seq, paused).await {
                let _ = out_tx.send(ServerWsEvent::Error {
                    code: "pause_failed".to_string(),
                    message: msg,
                    command_seq: Some(command_seq),
                });
            }
        }
        ClientWsCommand::Seek {
            command_seq,
            position_ms,
        } => {
            coord.claim_session_if_needed(conn_id);
            if let Err(msg) = coord.seek(command_seq, position_ms).await {
                let _ = out_tx.send(ServerWsEvent::Error {
                    code: "seek_failed".to_string(),
                    message: msg,
                    command_seq: Some(command_seq),
                });
            }
        }
        ClientWsCommand::PreloadNext {
            command_seq,
            locator,
        } => {
            coord.claim_session_if_needed(conn_id);
            if let Err(msg) = coord.preload_next(command_seq, *locator).await {
                let _ = out_tx.send(ServerWsEvent::Error {
                    code: "preload_failed".to_string(),
                    message: msg,
                    command_seq: Some(command_seq),
                });
            }
        }
        ClientWsCommand::Stop { command_seq, .. } => {
            coord.claim_session_if_needed(conn_id);
            let _ = coord.stop_playback(Some(command_seq)).await;
        }
        ClientWsCommand::SelectOutput {
            command_seq,
            output_id,
        } => {
            coord.claim_session_if_needed(conn_id);
            match coord
                .update_config(UpdateConfigRequest {
                    active_output_id: Some(output_id),
                    optical_idle_keepalive: None,
                    optical_dither_subaudible: None,
                })
                .await
            {
                Ok(_) => coord.broadcast_state_tick(),
                Err(msg) => {
                    let _ = out_tx.send(ServerWsEvent::Error {
                        code: "select_output_failed".to_string(),
                        message: msg,
                        command_seq: Some(command_seq),
                    });
                }
            }
        }
        ClientWsCommand::RefreshLocatorResponse {
            request_id,
            locator,
            error,
        } => {
            let res = match locator {
                Some(loc) => Ok(*loc),
                None => Err(error.unwrap_or_else(|| "locator refresh failed".to_string())),
            };
            coord.resolve_locator_refresh(&request_id, res).await;
        }
        ClientWsCommand::Hello { .. } | ClientWsCommand::Ping { .. } => {}
    }
}
