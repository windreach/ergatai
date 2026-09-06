import { I18nextProvider } from "react-i18next";

import { WorkspaceShell, i18n } from "@ergatai/ui-core";

export default function App() {
  return (
    <I18nextProvider i18n={i18n}>
      <WorkspaceShell />
    </I18nextProvider>
  );
}
