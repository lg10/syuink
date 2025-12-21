use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum Packet {
    /// Pure IP Data Packet (from/to TUN interface)
    IpData(Vec<u8>),
    
    /// Broadcast/Multicast Packet (for Device Discovery)
    /// We wrap these separately to handle them with special logic (re-broadcasting)
    Broadcast {
        protocol: BroadcastProtocol,
        payload: Vec<u8>,
    },
    
    /// Control Message for signaling and management
    Control(ControlMessage),
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum BroadcastProtocol {
    Mdns, // UDP 5353
    Ssdp, // UDP 1900
    Lmnr, // UDP 5355 (Link-Local Multicast Name Resolution)
    Other(u16),
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum ControlMessage {
    Handshake { 
        device_id: Uuid, 
        group_id: String,
        hostname: String 
    },
    KeepAlive,
    Disconnect,
}
