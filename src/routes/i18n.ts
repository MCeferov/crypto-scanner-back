import { Router, type IRouter, type Request, type Response } from "express";
import { getLocaleMeta, getMessages, isValidLocale, DEFAULT_LOCALE } from "@workspace/i18n";

const router: IRouter = Router();

/** GET /api/i18n/locales — dəstəklənən dillər */
router.get("/locales", (_req: Request, res: Response) => {
  res.json({ locales: getLocaleMeta(), default: DEFAULT_LOCALE });
});

/** GET /api/i18n/messages/:lang — tərcümə paketi */
router.get("/messages/:lang", (req: Request, res: Response) => {
  const lang = String(req.params.lang);
  if (!isValidLocale(lang)) {
    res.status(400).json({ error: "Unsupported locale" });
    return;
  }
  res.json({ locale: lang, messages: getMessages(lang) });
});

export default router;
