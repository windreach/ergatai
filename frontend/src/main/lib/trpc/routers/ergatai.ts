import { mergeRouters } from "@trpc/server/unstable-core-do-not-import"
import { agentsRouter } from "./ergatai-agents.router"
import { conversationsRouter } from "./ergatai-conversations.router"
import { workspacesRouter } from "./ergatai-workspaces.router"
import { projectsRouter } from "./ergatai-projects.router"
import { chatsRouter } from "./ergatai-chats.router"
import { profilesRouter } from "./ergatai-profiles.router"
import { dagsRouter } from "./ergatai-dags.router"
import { statusRouter } from "./ergatai-status.router"

export const ergataiRouter = mergeRouters(
  agentsRouter,
  conversationsRouter,
  workspacesRouter,
  projectsRouter,
  chatsRouter,
  profilesRouter,
  dagsRouter,
  statusRouter,
)

export type {
  ErgataiProject,
  ErgataiWorkspace,
  ErgataiWorkspaceProject,
  ErgataiWorkspaceStatus,
  ErgataiConversation,
  ErgataiMessage,
} from "./ergatai-shared"
