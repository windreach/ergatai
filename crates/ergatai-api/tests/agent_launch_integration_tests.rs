//! End-to-end launch test with the mock ACP agent.
//!
//! This exercises the real `AgentLaunchService::ensure` path: resolve the
//! conversation, read the durable model, launch the process, apply the model
//! through ACP, and persist the runtime row.

use std::path::PathBuf;

use ergatai_api::context::{get_app_context, init_app_context, AppContext};
use ergatai_api::services::agent_launch::{
    AgentLaunchService, EnsureAgentRequest, LaunchAction, LaunchMode, ModelInput, ModelSource,
};
use ergatai_api::user_data_db::{
    self, Chat, CollaborationSession, Conversation, ConversationLaunchSettings, Workspace,
};
use ergatai_error::{ChatId, CollaborationSessionId, ConversationId, WorkspaceId};
use ergatai_runtime::get_agent_runtime;
use std::time::Duration;

fn mock_agent_command() -> String {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let script = PathBuf::from(manifest_dir)
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("scripts/mock-acp-agent.py");
    format!("python3 {}", script.display())
}

fn init_test_environment() {
    let data_dir = std::env::temp_dir()
        .join("ergatai-agent-launch-tests")
        .join(std::process::id().to_string());
    let _ = std::fs::remove_dir_all(&data_dir);
    std::fs::create_dir_all(&data_dir).expect("create test data dir");
    std::env::set_var("ERGATAI_DATA_DIR", &data_dir);

    let runtime = get_agent_runtime();
    let ctx = AppContext::new(runtime, None, user_data_db::get_user_data_db());
    init_app_context(ctx);
}

fn seed_conversation(work_dir: &str) -> ConversationId {
    let workspace_id = WorkspaceId::new(7001);
    let chat_id = ChatId::new(7002);
    let session_id = CollaborationSessionId::new(7003);
    let conversation_id = ConversationId::new(7004);

    user_data_db::workspaces::create(Workspace {
        workspace_id,
        name: "Agent Launch Test Workspace".to_string(),
        work_dir: work_dir.to_string(),
        env: "{}".to_string(),
        resources: "{}".to_string(),
        config: "{}".to_string(),
        collaboration_mode: "supervisor".to_string(),
        status: "active".to_string(),
        default_project_id: None,
        created_at: 1000,
        updated_at: 1000,
    })
    .expect("create workspace");

    user_data_db::chats::create(Chat {
        chat_id,
        workspace_id,
        name: Some("Agent Launch Test Chat".to_string()),
        collaboration_mode: Some("supervisor".to_string()),
        worktree_path: Some(work_dir.to_string()),
        branch: None,
        base_branch: None,
        pr_url: None,
        pr_number: None,
        created_at: 1000,
        updated_at: 1000,
        archived_at: None,
    })
    .expect("create chat");

    user_data_db::collaboration_sessions::create(CollaborationSession {
        collaboration_session_id: session_id,
        chat_id,
        workspace_id,
        mode: "supervisor".to_string(),
        state: "idle".to_string(),
        goal: None,
        active_plan_revision: None,
        created_at: 1000,
        updated_at: 1000,
    })
    .expect("create collaboration session");

    user_data_db::conversations::create(Conversation {
        conversation_id,
        collaboration_session_id: session_id,
        chat_id,
        parent_id: None,
        name: Some("Agent Launch Test Conversation".to_string()),
        mode: "agent".to_string(),
        participant_role: "peer".to_string(),
        status: "ready".to_string(),
        created_at: 1000,
        updated_at: 1000,
        context_used: 0,
        context_window: 0,
        context_updated_at: 0,
    })
    .expect("create conversation");

    conversation_id
}

#[tokio::test]
async fn ensure_applies_durable_conversation_model_before_returning() {
    init_test_environment();

    // Profile registry and the custom mock profile.
    ergatai_api::services::profile_service::init_profile_registry().expect("init profile registry");
    ergatai_api::services::profile_service::register_profile(
        "mock-acp".to_string(),
        mock_agent_command(),
        "acp".to_string(),
        None,
        None,
        None,
        None,
    )
    .await
    .expect("register mock profile");

    let work_dir = std::env::temp_dir()
        .join("ergatai-agent-launch-tests-workdir")
        .to_string_lossy()
        .to_string();
    std::fs::create_dir_all(&work_dir).expect("create work dir");
    let conversation_id = seed_conversation(&work_dir);

    // The durable selection wins over the adapter's native default.
    user_data_db::conversation_launch_settings::upsert(&ConversationLaunchSettings {
        conversation_id,
        profile_name: Some("mock-acp".to_string()),
        model: Some("glm-5.3-flash".to_string()),
        model_options_json: "{}".to_string(),
        provider_connection_id: None,
        source: "initial".to_string(),
        updated_at: 2000,
    })
    .expect("seed launch settings");

    let service: std::sync::Arc<AgentLaunchService> = get_app_context().agent_launch.clone();
    let result = service
        .ensure(EnsureAgentRequest {
            conversation_id: Some(conversation_id),
            profile: Some("mock-acp".to_string()),
            workspace_id: None,
            work_dir: None,
            provider_connection_id: None,
            model: ModelInput::None,
            mode: LaunchMode::Ensure,
            env: Default::default(),
            allow_native_default: false,
        })
        .await
        .expect("ensure should launch the mock agent");

    assert_eq!(result.action, LaunchAction::Spawned);
    let expected_conversation_id = conversation_id.encode();
    assert_eq!(
        result.conversation_id.as_deref(),
        Some(expected_conversation_id.as_str())
    );
    let applied = result.model.expect("model should be applied");
    assert_eq!(applied.selection.id, "glm-5.3-flash");
    assert_eq!(applied.source, ModelSource::ConversationInitial);

    // The runtime agent's live config option must reflect the applied model.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let live_model =
        ergatai_api::services::agent_service::get_agent_current_model(&result.agent_id)
            .await
            .expect("mock agent should expose a current model");
    assert_eq!(live_model, "glm-5.3-flash");

    // Runtime persistence carries the conversation key and source.
    let (profile, model, source, _) = user_data_db::get_agent_runtime_model(&result.agent_id)
        .expect("read runtime model")
        .expect("runtime model row should exist");
    assert_eq!(profile.as_deref(), Some("mock-acp"));
    assert_eq!(model.as_deref(), Some("glm-5.3-flash"));
    assert_eq!(source.as_deref(), Some("initial"));

    let bound = user_data_db::conversations::get_current_agent_id(conversation_id)
        .expect("read current agent");
    assert_eq!(bound.as_deref(), Some(result.agent_id.as_str()));

    // Suspend and ensure again: the same conversation model must be restored on
    // resume, not the adapter's native default.
    let runtime = get_agent_runtime();
    runtime
        .suspend_agent(
            &result.agent_id,
            ergatai_runtime::suspend_store::SuspendReason::Manual,
        )
        .await
        .expect("suspend mock agent");

    let resumed = service
        .ensure(EnsureAgentRequest {
            conversation_id: Some(conversation_id),
            profile: Some("mock-acp".to_string()),
            workspace_id: None,
            work_dir: None,
            provider_connection_id: None,
            model: ModelInput::None,
            mode: LaunchMode::Ensure,
            env: Default::default(),
            allow_native_default: false,
        })
        .await
        .expect("ensure should resume the mock agent");

    assert_eq!(resumed.action, LaunchAction::Resumed);
    assert_eq!(resumed.agent_id, result.agent_id);
    assert_eq!(
        resumed.model.expect("resumed model").selection.id,
        "glm-5.3-flash"
    );

    let _ = runtime.stop_agent(&resumed.agent_id).await;
}
