import { renderSVG } from "uqr";
// Server-side QR so the otpauth secret never reaches a third-party service.
export const qrSvg = (text) => renderSVG(text, { ecc: "M", border: 2 });
