#![forbid(unsafe_code)]

use soundclud_receiver::cli::{parse_cli_args, CliOutcome};
use soundclud_receiver::server::ReceiverServer;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let opts = match parse_cli_args(&args) {
        Ok(CliOutcome::PrintHelp(text)) | Ok(CliOutcome::PrintVersion(text)) => {
            println!("{text}");
            return;
        }
        Ok(CliOutcome::Run(opts)) => *opts,
        Err(err) => {
            eprintln!("error: {err}\nRun with --help for usage.");
            std::process::exit(2);
        }
    };

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let cfg = opts.into_daemon_config();
    let server = match ReceiverServer::start(cfg).await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("failed to start soundclud-receiver: {e}");
            std::process::exit(1);
        }
    };

    let (rid, rname) = server.coordinator().receiver_identity();
    tracing::info!(
        receiver_id = %rid,
        receiver_name = %rname,
        listen = %server.local_addr(),
        "soundclud-receiver listening (0 dB bit-perfect mode)"
    );

    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down soundclud-receiver");
    server.shutdown().await;
}
