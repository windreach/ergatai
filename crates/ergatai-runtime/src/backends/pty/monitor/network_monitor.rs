//! Network traffic monitor for detecting API calls
//!
//! Monitors /proc/{pid}/net/tcp to detect connections to LLM APIs
//! and analyze traffic patterns to infer reasoning state.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, warn};

/// Network monitor for an agent process
pub struct NetworkMonitor {
    pid: u32,
    state: Arc<RwLock<NetworkState>>,
}

#[derive(Debug, Clone)]
pub struct NetworkState {
    pub connections: Vec<ConnectionInfo>,
    pub bytes_sent: u64,
    pub bytes_recv: u64,
    pub has_llm_api_connection: bool,
    pub last_update: u64,
}

#[derive(Debug, Clone)]
pub struct ConnectionInfo {
    pub local_addr: SocketAddr,
    pub remote_addr: SocketAddr,
    pub state: TcpState,
    pub is_llm_api: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TcpState {
    Established,
    Listen,
    TimeWait,
    CloseWait,
    Other(u8),
}

impl NetworkMonitor {
    pub fn new(pid: u32) -> Self {
        Self {
            pid,
            state: Arc::new(RwLock::new(NetworkState {
                connections: Vec::new(),
                bytes_sent: 0,
                bytes_recv: 0,
                has_llm_api_connection: false,
                last_update: 0,
            })),
        }
    }

    /// Update network state from /proc
    pub async fn update(&self) -> Result<(), std::io::Error> {
        let connections = self.read_tcp_connections().await?;
        let io_stats = self.read_io_stats().await?;

        let has_llm_api = connections.iter().any(|c| c.is_llm_api);

        let mut state = self.state.write().await;
        state.connections = connections;
        state.bytes_sent = io_stats.bytes_sent;
        state.bytes_recv = io_stats.bytes_recv;
        state.has_llm_api_connection = has_llm_api;
        state.last_update = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        debug!(
            pid = self.pid,
            connections = state.connections.len(),
            has_llm_api = has_llm_api,
            "Network state updated"
        );

        Ok(())
    }

    /// Get current network state
    pub async fn snapshot(&self) -> NetworkState {
        self.state.read().await.clone()
    }

    /// Detect if agent is calling LLM API (reasoning)
    pub async fn detect_api_call(&self) -> ApiCallPattern {
        let state = self.state.read().await;

        if !state.has_llm_api_connection {
            return ApiCallPattern::None;
        }

        // Check for established connections to LLM API
        let llm_connections: Vec<_> = state
            .connections
            .iter()
            .filter(|c| c.is_llm_api && c.state == TcpState::Established)
            .collect();

        if llm_connections.is_empty() {
            return ApiCallPattern::None;
        }

        // Analyze traffic pattern
        // If we have established connections to LLM API, agent is likely reasoning
        ApiCallPattern::Calling {
            target: llm_connections[0].remote_addr,
            established_connections: llm_connections.len(),
        }
    }

    /// Read TCP connections from /proc/{pid}/net/tcp
    async fn read_tcp_connections(&self) -> Result<Vec<ConnectionInfo>, std::io::Error> {
        let path = format!("/proc/{}/net/tcp", self.pid);
        let content = match tokio::fs::read_to_string(&path).await {
            Ok(c) => c,
            Err(e) => {
                warn!(pid = self.pid, error = %e, "Failed to read TCP connections");
                return Ok(Vec::new());
            }
        };

        let mut connections = Vec::new();

        for line in content.lines().skip(1) {
            // Skip header
            if let Some(conn) = self.parse_tcp_line(line) {
                connections.push(conn);
            }
        }

        Ok(connections)
    }

    /// Parse a line from /proc/net/tcp
    fn parse_tcp_line(&self, line: &str) -> Option<ConnectionInfo> {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 4 {
            return None;
        }

        let local_addr = self.parse_address(parts[1])?;
        let remote_addr = self.parse_address(parts[2])?;
        let state = self.parse_tcp_state(parts[3])?;

        let is_llm_api = self.is_llm_api_endpoint(&remote_addr);

        Some(ConnectionInfo {
            local_addr,
            remote_addr,
            state,
            is_llm_api,
        })
    }

    /// Parse address from /proc/net/tcp format (hex:port)
    fn parse_address(&self, addr: &str) -> Option<SocketAddr> {
        let parts: Vec<&str> = addr.split(':').collect();
        if parts.len() != 2 {
            return None;
        }

        let ip_hex = parts[0];
        let port_hex = parts[1];

        // Parse IP (little-endian in /proc)
        let ip_u32 = u32::from_str_radix(ip_hex, 16).ok()?;
        let ip = Ipv4Addr::from(ip_u32.swap_bytes());

        // Parse port
        let port = u16::from_str_radix(port_hex, 16).ok()?;

        Some(SocketAddr::new(IpAddr::V4(ip), port))
    }

    /// Parse TCP state from hex
    fn parse_tcp_state(&self, state_hex: &str) -> Option<TcpState> {
        let state = u8::from_str_radix(state_hex, 16).ok()?;

        Some(match state {
            0x01 => TcpState::Established,
            0x0A => TcpState::Listen,
            0x06 => TcpState::TimeWait,
            0x08 => TcpState::CloseWait,
            other => TcpState::Other(other),
        })
    }

    /// Check if address is a known LLM API endpoint
    fn is_llm_api_endpoint(&self, addr: &SocketAddr) -> bool {
        // Known LLM API IP ranges (simplified, should be updated regularly)
        let ip = addr.ip();

        match ip {
            IpAddr::V4(ipv4) => {
                let octets = ipv4.octets();

                // Anthropic API (example IPs, need real ranges)
                if octets[0] == 34 && octets[1] == 199 {
                    return true;
                }

                // OpenAI API (Cloudflare IPs)
                if octets[0] == 104 && octets[1] == 18 {
                    return true;
                }

                // Google AI (example)
                if octets[0] == 142 && octets[1] == 250 {
                    return true;
                }

                false
            }
            _ => false,
        }
    }

    /// Read I/O stats from /proc/{pid}/io
    async fn read_io_stats(&self) -> Result<IoStats, std::io::Error> {
        let path = format!("/proc/{}/io", self.pid);
        let content = match tokio::fs::read_to_string(&path).await {
            Ok(c) => c,
            Err(e) => {
                warn!(pid = self.pid, error = %e, "Failed to read I/O stats");
                return Ok(IoStats {
                    bytes_sent: 0,
                    bytes_recv: 0,
                });
            }
        };

        let mut bytes_sent = 0u64;
        let mut bytes_recv = 0u64;

        for line in content.lines() {
            if line.starts_with("write_bytes:") {
                bytes_sent = line
                    .split_whitespace()
                    .nth(1)
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
            }
        }

        // For recv, read /proc/net/dev
        if let Ok(net_content) = tokio::fs::read_to_string("/proc/net/dev").await {
            bytes_recv = self.parse_network_recv(&net_content).unwrap_or(0);
        }

        Ok(IoStats {
            bytes_sent,
            bytes_recv,
        })
    }

    /// Parse receive bytes from /proc/net/dev
    fn parse_network_recv(&self, content: &str) -> Option<u64> {
        for line in content.lines().skip(2) {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 10 {
                let iface = parts[0].trim_end_matches(':');
                // Skip loopback
                if iface == "lo" {
                    continue;
                }
                // First numeric field after interface name is rx_bytes
                if let Some(rx_bytes) = parts.get(1).and_then(|s| s.parse().ok()) {
                    return Some(rx_bytes);
                }
            }
        }
        None
    }
}

#[derive(Debug, Clone)]
pub struct IoStats {
    pub bytes_sent: u64,
    pub bytes_recv: u64,
}

/// API call pattern detected from network traffic
#[derive(Debug, Clone)]
pub enum ApiCallPattern {
    /// No API call detected
    None,

    /// API call in progress
    Calling {
        target: SocketAddr,
        established_connections: usize,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_address() {
        let monitor = NetworkMonitor::new(1);

        // Test parsing 0100007F:0050 (127.0.0.1:80 in little-endian)
        let addr = monitor.parse_address("0100007F:0050");
        assert!(addr.is_some());
        let addr = addr.unwrap();
        assert_eq!(addr.ip(), IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)));
        assert_eq!(addr.port(), 80);
    }

    #[test]
    fn test_parse_tcp_state() {
        let monitor = NetworkMonitor::new(1);

        assert_eq!(monitor.parse_tcp_state("01"), Some(TcpState::Established));
        assert_eq!(monitor.parse_tcp_state("0A"), Some(TcpState::Listen));
        assert_eq!(monitor.parse_tcp_state("06"), Some(TcpState::TimeWait));
    }
}
