use std::net::Ipv4Addr;
use tokio::io::{ReadHalf, WriteHalf};
use tun::Configuration;
pub use tun::AsyncDevice; // Re-export for consumers
use anyhow::{Result, Context};

pub struct TunDevice {
    reader: ReadHalf<AsyncDevice>,
    writer: WriteHalf<AsyncDevice>,
}

impl TunDevice {
    pub fn create(ip: Ipv4Addr, netmask: Ipv4Addr) -> Result<Self> {
        let mut config = Configuration::default();
        
        config
            .address(ip)
            .netmask(netmask)
            .name("Syuink") // Simple name to avoid issues
            .up();

        #[cfg(target_os = "linux")]
        config.platform(|config| {
            config.packet_information(false); // Pure IP packets
        });

        #[cfg(target_os = "windows")]
        config.platform(|config| {
            // Windows Wintun settings
            // We use default settings for now which usually works fine with Wintun
        });

        let dev = tun::create_as_async(&config).context("Failed to create TUN device")?;
        
        let (reader, writer) = tokio::io::split(dev);

        Ok(Self {
            reader,
            writer,
        })
    }

    pub fn split(self) -> (ReadHalf<AsyncDevice>, WriteHalf<AsyncDevice>) {
        (self.reader, self.writer)
    }
}
