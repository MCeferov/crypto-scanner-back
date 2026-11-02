import type { Locale } from "../i18n/types";

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

interface Copy {
  subject: string;
  intro: string;
  expires: string;
  ignore: string;
}

const COPY: Record<Locale, Copy> = {
  az: {
    subject: "Crypto Scanner — təsdiq kodunuz",
    intro: "Qeydiyyatı tamamlamaq üçün bu kodu daxil edin:",
    expires: "Kod {minutes} dəqiqə ərzində etibarlıdır.",
    ignore: "Bu sorğunu siz göndərməmisinizsə, bu məktubu nəzərə almayın.",
  },
  en: {
    subject: "Crypto Scanner — your verification code",
    intro: "Enter this code to finish creating your account:",
    expires: "The code is valid for {minutes} minutes.",
    ignore: "If you did not request this, you can ignore this email.",
  },
  ru: {
    subject: "Crypto Scanner — код подтверждения",
    intro: "Введите этот код, чтобы завершить регистрацию:",
    expires: "Код действителен {minutes} минут.",
    ignore: "Если вы не запрашивали код, просто проигнорируйте это письмо.",
  },
  tr: {
    subject: "Crypto Scanner — doğrulama kodunuz",
    intro: "Kaydı tamamlamak için bu kodu girin:",
    expires: "Kod {minutes} dakika boyunca geçerlidir.",
    ignore: "Bu isteği siz yapmadıysanız bu e-postayı yok sayabilirsiniz.",
  },
};

/** The code is digits only, so nothing user-controlled reaches the HTML. */
export function renderVerificationEmail(locale: Locale, code: string, ttlMinutes: number): RenderedEmail {
  const c = COPY[locale] ?? COPY.en;
  const expires = c.expires.replace("{minutes}", String(ttlMinutes));

  const text = `${c.intro}\n\n${code}\n\n${expires}\n${c.ignore}\n`;
  const html =
    `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px">` +
    `<p>${c.intro}</p>` +
    `<p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:24px 0">${code}</p>` +
    `<p style="color:#555">${expires}</p>` +
    `<p style="color:#888;font-size:12px">${c.ignore}</p>` +
    `</div>`;

  return { subject: c.subject, text, html };
}
