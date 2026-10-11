import { I18nextProvider } from "react-i18next";

import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";
import i18n from "@/i18n";

export default function App() {
  return (
    <I18nextProvider i18n={i18n}>
      <WorkspaceShell />
    </I18nextProvider>
  );
}
