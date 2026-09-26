//! MCP-over-ACP — Provide MCP tools to ACP agents via native ACP transport.
//!
//! The bridge declares an ACP-transport MCP server in `session/new` or
//! `session/load`, then translates the ACP `mcp/*` envelope messages to and
//! from the concrete MCP server component supplied by the application.

use std::collections::HashMap;
use std::sync::Arc;

use agent_client_protocol::schema::v1::{
    ConnectMcpRequest, ConnectMcpResponse, DisconnectMcpRequest, DisconnectMcpResponse,
    McpConnectionId, McpServer, McpServerAcp, McpServerAcpId, MessageMcpNotification,
    MessageMcpRequest, MessageMcpResponse,
};
use agent_client_protocol::util::MatchDispatchFrom;
use agent_client_protocol::{
    role, Agent, Channel, ConnectTo, ConnectionTo, Dispatch, DynConnectTo, HandleDispatchFrom,
    Handled, JsonRpcResponse, Responder, UntypedMessage,
};
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use tracing::{debug, info, warn};

/// Context for an MCP server attached to one ACP agent connection.
#[derive(Clone, Debug, Default)]
pub struct McpServerContext {
    /// Runtime agent ID that owns the ACP connection.
    pub agent_id: Option<String>,
    /// Workspace the owning agent was launched in.
    pub workspace_id: Option<String>,
}

/// Creates MCP server components for ACP sessions.
pub trait McpServerFactory: Send + Sync + 'static {
    /// Create a component that can serve one MCP-over-ACP connection.
    fn create_mcp_server(&self, context: McpServerContext) -> DynConnectTo<role::mcp::Client>;

    /// Get the server name used in the ACP declaration.
    fn server_name(&self) -> &str;
}

/// Native ACP MCP-over-ACP bridge for one agent connection.
pub struct AcpMcpBridge {
    server_id: McpServerAcpId,
    factory: Arc<dyn McpServerFactory>,
    context: McpServerContext,
    connections: HashMap<McpConnectionId, futures::channel::mpsc::Sender<Dispatch>>,
}

impl AcpMcpBridge {
    pub fn new(factory: Arc<dyn McpServerFactory>, context: McpServerContext) -> Self {
        Self {
            server_id: McpServerAcpId::new(format!("ergatai-mcp:{}", uuid::Uuid::new_v4())),
            factory,
            context,
            connections: HashMap::new(),
        }
    }

    pub fn declaration(&self) -> McpServer {
        McpServer::Acp(McpServerAcp::new(
            self.factory.server_name(),
            self.server_id.clone(),
        ))
    }

    fn handle_connect_request(
        &mut self,
        request: ConnectMcpRequest,
        responder: Responder<ConnectMcpResponse>,
        acp_connection: &ConnectionTo<Agent>,
    ) -> Result<
        Handled<(ConnectMcpRequest, Responder<ConnectMcpResponse>)>,
        agent_client_protocol::Error,
    > {
        if request.server_id != self.server_id {
            return Ok(Handled::No {
                message: (request, responder),
                retry: false,
            });
        }

        let connection_id =
            McpConnectionId::new(format!("mcp-over-acp-connection:{}", uuid::Uuid::new_v4()));
        let (mcp_server_tx, mut mcp_server_rx) = futures::channel::mpsc::channel::<Dispatch>(128);
        self.connections
            .insert(connection_id.clone(), mcp_server_tx);

        let (client_channel, server_channel) = Channel::duplex();
        let client_component = {
            let connection_id = connection_id.clone();
            let acp_connection = acp_connection.clone();
            role::mcp::Client
                .builder()
                .on_receive_dispatch(
                    async move |message: Dispatch, _mcp_connection| match message {
                        Dispatch::Request(request, responder) => {
                            let (method, params) = request.into_parts();
                            let params = match params {
                                Value::Object(params) => Some(params),
                                Value::Null => None,
                                invalid => {
                                    warn!(?invalid, "Ignoring MCP request with positional params");
                                    return Ok(());
                                }
                            };
                            let request = MessageMcpRequest::new(connection_id.clone(), method)
                                .params(params);
                            let responder = responder.wrap_params(|method, result| {
                                result.and_then(|response: MessageMcpResponse| {
                                    response.into_json(method)
                                })
                            });
                            acp_connection.send_proxied_message_to(
                                Agent,
                                Dispatch::<MessageMcpRequest, MessageMcpNotification>::Request(
                                    request, responder,
                                ),
                            )
                        }
                        Dispatch::Notification(notification) => {
                            let (method, params) = notification.into_parts();
                            let params = match params {
                                Value::Object(params) => Some(params),
                                Value::Null => None,
                                invalid => {
                                    warn!(
                                        ?invalid,
                                        "Ignoring MCP notification with positional params"
                                    );
                                    return Ok(());
                                }
                            };
                            let notification =
                                MessageMcpNotification::new(connection_id.clone(), method)
                                    .params(params);
                            acp_connection.send_proxied_message_to(
                                Agent,
                                Dispatch::<MessageMcpRequest, MessageMcpNotification>::Notification(
                                    notification,
                                ),
                            )
                        }
                        Dispatch::Response(result, router) => router.route_with_result(result),
                    },
                    agent_client_protocol::on_receive_dispatch!(),
                )
                .with_spawned(move |mcp_connection| async move {
                    while let Some(message) = mcp_server_rx.next().await {
                        mcp_connection.send_proxied_message_to(role::mcp::Server, message)?;
                    }
                    Ok(())
                })
        };

        let spawned_server = self.factory.create_mcp_server(self.context.clone());
        let spawn_results = acp_connection
            .spawn(async move { client_component.connect_to(client_channel).await })
            .and_then(|()| {
                acp_connection.spawn(async move { spawned_server.connect_to(server_channel).await })
            });

        match spawn_results {
            Ok(()) => {
                responder.respond(ConnectMcpResponse::new(connection_id))?;
                Ok(Handled::Yes)
            }
            Err(error) => {
                self.connections.remove(&connection_id);
                responder.respond_with_error(error)?;
                Ok(Handled::Yes)
            }
        }
    }

    async fn handle_message_request(
        &mut self,
        request: MessageMcpRequest,
        responder: Responder<MessageMcpResponse>,
    ) -> Result<
        Handled<(MessageMcpRequest, Responder<MessageMcpResponse>)>,
        agent_client_protocol::Error,
    > {
        let Some(mcp_server_tx) = self.connections.get_mut(&request.connection_id) else {
            return Ok(Handled::No {
                message: (request, responder),
                retry: false,
            });
        };
        let method = request.method.clone();
        let untyped = UntypedMessage {
            method,
            params: request.params.map(Value::Object).unwrap_or(Value::Null),
        };
        let responder = responder.wrap_params(|method, result| {
            result.and_then(|response| MessageMcpResponse::from_value(method, response))
        });
        mcp_server_tx
            .send(Dispatch::Request(untyped, responder))
            .await
            .map_err(|error| {
                agent_client_protocol::Error::internal_error().data(error.to_string())
            })?;
        Ok(Handled::Yes)
    }

    async fn handle_message_notification(
        &mut self,
        notification: MessageMcpNotification,
    ) -> Result<Handled<MessageMcpNotification>, agent_client_protocol::Error> {
        let Some(mcp_server_tx) = self.connections.get_mut(&notification.connection_id) else {
            return Ok(Handled::No {
                message: notification,
                retry: false,
            });
        };
        let untyped = UntypedMessage {
            method: notification.method.clone(),
            params: notification
                .params
                .map(Value::Object)
                .unwrap_or(Value::Null),
        };
        mcp_server_tx
            .send(Dispatch::Notification(untyped))
            .await
            .map_err(|error| {
                agent_client_protocol::Error::internal_error().data(error.to_string())
            })?;
        Ok(Handled::Yes)
    }

    fn handle_disconnect_request(
        &mut self,
        request: DisconnectMcpRequest,
        responder: Responder<DisconnectMcpResponse>,
    ) -> Result<
        Handled<(DisconnectMcpRequest, Responder<DisconnectMcpResponse>)>,
        agent_client_protocol::Error,
    > {
        if self.connections.remove(&request.connection_id).is_none() {
            return Ok(Handled::No {
                message: (request, responder),
                retry: false,
            });
        }
        responder.respond(DisconnectMcpResponse::new())?;
        Ok(Handled::Yes)
    }
}

impl HandleDispatchFrom<Agent> for AcpMcpBridge {
    async fn handle_dispatch_from(
        &mut self,
        message: Dispatch,
        connection: ConnectionTo<Agent>,
    ) -> Result<Handled<Dispatch>, agent_client_protocol::Error> {
        MatchDispatchFrom::new(message, &connection)
            .if_request_from(Agent, async |request: ConnectMcpRequest, responder| {
                self.handle_connect_request(request, responder, &connection)
            })
            .await
            .if_request_from(Agent, async |request: MessageMcpRequest, responder| {
                self.handle_message_request(request, responder).await
            })
            .await
            .if_notification_from(Agent, async |notification: MessageMcpNotification| {
                self.handle_message_notification(notification).await
            })
            .await
            .if_request_from(Agent, async |request: DisconnectMcpRequest, responder| {
                self.handle_disconnect_request(request, responder)
            })
            .await
            .done()
    }

    fn describe_chain(&self) -> impl std::fmt::Debug {
        format!("AcpMcpBridge({})", self.factory.server_name())
    }
}

/// Configuration for MCP-over-ACP.
#[derive(Debug, Clone)]
pub struct McpOverAcpConfig {
    /// Whether MCP-over-ACP is enabled.
    pub enabled: bool,
    /// Server name.
    pub server_name: String,
}

impl McpOverAcpConfig {
    /// Load configuration from environment variables.
    pub fn from_env() -> Self {
        Self {
            enabled: match std::env::var("ERGATAI_MCP_OVER_ACP_ENABLED") {
                Ok(value) => !matches!(value.trim().to_lowercase().as_str(), "0" | "false"),
                Err(_) => true,
            },
            server_name: std::env::var("ERGATAI_MCP_SERVER_NAME")
                .unwrap_or_else(|_| "Ergatai MCP Tools".to_string()),
        }
    }
}

/// Check if MCP-over-ACP is enabled via environment variable.
pub fn is_enabled() -> bool {
    McpOverAcpConfig::from_env().enabled
}

/// Helper function to check if MCP-over-ACP is enabled.
pub fn create_config_if_enabled() -> Option<McpOverAcpConfig> {
    let config = McpOverAcpConfig::from_env();
    if config.enabled {
        info!("MCP-over-ACP enabled");
        Some(config)
    } else {
        debug!("MCP-over-ACP disabled");
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_from_env() {
        std::env::remove_var("ERGATAI_MCP_OVER_ACP_ENABLED");
        let config = McpOverAcpConfig::from_env();
        assert!(config.enabled);

        std::env::set_var("ERGATAI_MCP_OVER_ACP_ENABLED", "0");
        let config = McpOverAcpConfig::from_env();
        assert!(!config.enabled);

        std::env::set_var("ERGATAI_MCP_OVER_ACP_ENABLED", "1");
        let config = McpOverAcpConfig::from_env();
        assert!(config.enabled);

        std::env::remove_var("ERGATAI_MCP_OVER_ACP_ENABLED");
    }

    #[test]
    fn test_mcp_server_context_default() {
        let context = McpServerContext::default();
        assert!(context.agent_id.is_none());
        assert!(context.workspace_id.is_none());
    }

    #[test]
    fn test_mcp_server_context_with_values() {
        let context = McpServerContext {
            agent_id: Some("agent-1".to_string()),
            workspace_id: Some("workspace-1".to_string()),
        };
        assert_eq!(context.agent_id, Some("agent-1".to_string()));
        assert_eq!(context.workspace_id, Some("workspace-1".to_string()));
    }
}
