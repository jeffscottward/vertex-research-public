import { LegalPage } from "../../_components/legal-page.tsx";

export const metadata = {
  title: "Privacy notice",
  description:
    "A starter privacy notice outline that requires qualified legal review before production use.",
};

export default function LegalPrivacyPage() {
  return <LegalPage kind="privacy" />;
}
