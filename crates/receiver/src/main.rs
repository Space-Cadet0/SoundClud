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

    #[cfg(target_os = "macos")]
    if !opts.heos_only {
        wait_for_macos_coreaudiod(std::time::Duration::from_secs(15)).await;
    }

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

#[cfg(target_os = "macos")]
async fn wait_for_macos_coreaudiod(max_wait: std::time::Duration) {
    let deadline = tokio::time::Instant::now() + max_wait;
    while tokio::time::Instant::now() < deadline {
        let running = tokio::process::Command::new("pgrep")
            .args(["-x", "coreaudiod"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .is_ok_and(|st| st.success());
        if running {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}
