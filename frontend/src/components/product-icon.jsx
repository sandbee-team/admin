import {
  Fingerprint,
  ScanLine,
  MessagesSquare,
  Store,
  Cloud,
  Server,
  Package,
  Wallet,
  Globe,
} from "lucide-react";
export function ProductIcon({ product, size = 20 }) {
  const bySlug = {
    gst: Fingerprint,
    ocr: ScanLine,
    messaging: MessagesSquare,
    pos: Store,
  };
  const byModel = {
    "hosted-api": Server,
    "customer-package": Package,
    "prepaid-service": Wallet,
    "customer-deployment": Cloud,
    saas: Globe,
  };
  const Icon = bySlug[product?.slug] || byModel[product?.model] || Globe;
  return <Icon size={size} />;
}
