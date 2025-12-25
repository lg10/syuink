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
            .up();

        // On macOS, explicitly naming the device can cause conflicts if the name is already taken.
        // It's better to let the OS assign the next available utunX device.
        #[cfg(not(target_os = "macos"))]
        config.name("Syuink");

        // We want pure IP packets (no PI header) on all platforms for consistency
        config.platform(|config| {
            config.packet_information(false);
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
