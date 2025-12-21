use std::process::Command;
use std::net::Ipv4Addr;
use tracing::{info, error, debug};

pub struct RouteManager {
    added_routes: Vec<Ipv4Addr>,
    local_vpn_ip: String,
    interface_index: Option<u32>, // Useful for Windows if we can get it
}

impl RouteManager {
    pub fn new(local_vpn_ip: String) -> Self {
        Self {
            added_routes: Vec::new(),
            local_vpn_ip,
            interface_index: None,
        }
    }

    pub fn update_routes(&mut self, new_targets: &[Ipv4Addr]) {
        // 1. Remove routes that are no longer present
        let to_remove: Vec<Ipv4Addr> = self.added_routes.iter()
            .filter(|ip| !new_targets.contains(ip))
            .cloned()
            .collect();
            
        for ip in to_remove {
            self.remove_route(ip);
        }

        // 2. Add new routes
        for &ip in new_targets {
            if !self.added_routes.contains(&ip) {
                self.add_route(ip);
            }
        }
    }

    fn add_route(&mut self, target: Ipv4Addr) {
        info!("Adding route for {} via VPN", target);
        
        #[cfg(target_os = "windows")]
        {
            // route add <target> mask 255.255.255.255 <local_ip>
            // Using local_ip as gateway for TUN usually works to direct traffic into the interface
            let output = Command::new("route")
                .args(&["add", &target.to_string(), "mask", "255.255.255.255", &self.local_vpn_ip])
                .output();

            match output {
                Ok(o) => {
                    if o.status.success() {
                        debug!("Route add success");
                        self.added_routes.push(target);
                    } else {
                        // Check if "Object already exists" (exit code usually non-zero)
                        let err = String::from_utf8_lossy(&o.stderr);
                        if !err.contains("exists") {
                            error!("Route add failed: {}", err);
                        } else {
                             // Treat as success/already there
                             self.added_routes.push(target);
                        }
                    }
                },
                Err(e) => error!("Failed to run route command: {}", e),
            }
        }

        #[cfg(target_os = "linux")]
        {
            // ip route add <target>/32 dev <dev_name>
            // Since we don't easily have dev name here, we rely on `via`.
            // But for Point-to-Point TUN, `via` might be tricky.
            // Let's assume the user has configured basic routing or we use `ip route add <target> dev tun0`
            // Hardcoding 'syuink0' or similar if we knew it.
            // For now, log warning on Linux as we need device name context.
            error!("Auto-route on Linux requires device name context (TODO)");
        }

        #[cfg(target_os = "macos")]
        {
            // route -n add <target> -interface <dev> 
            // OR route -n add <target> <local_ip>
            let output = Command::new("route")
                .args(&["-n", "add", &target.to_string(), &self.local_vpn_ip])
                .output();
            
            match output {
                Ok(o) => {
                     if o.status.success() {
                         self.added_routes.push(target);
                     } else {
                         error!("Route add failed: {}", String::from_utf8_lossy(&o.stderr));
                     }
                },
                Err(e) => error!("Failed to run route command: {}", e),
            }
        }
    }

    fn remove_route(&mut self, target: Ipv4Addr) {
        info!("Removing route for {}", target);
        
        #[cfg(target_os = "windows")]
        {
            let _ = Command::new("route")
                .args(&["delete", &target.to_string()])
                .output();
        }

        #[cfg(target_os = "macos")]
        {
             let _ = Command::new("route")
                .args(&["-n", "delete", &target.to_string()])
                .output();
        }

        self.added_routes.retain(|&x| x != target);
    }

    pub fn cleanup(&mut self) {
        info!("Cleaning up {} routes...", self.added_routes.len());
        let routes = self.added_routes.clone();
        for ip in routes {
            self.remove_route(ip);
        }
    }
}
