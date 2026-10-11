import { useTranslation } from "react-i18next";

export function PlaceholderPanel({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full items-center justify-center bg-chat text-sm text-faint">
      {t("tabs.comingSoon", { title: t(titleKey) })}
    </div>
  );
}
