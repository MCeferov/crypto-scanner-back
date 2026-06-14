import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import binanceRouter from "./binance";
import marketsRouter from "./markets";
import i18nRouter from "./i18n";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/binance", binanceRouter);
router.use("/markets", marketsRouter);
router.use("/i18n", i18nRouter);

export default router;
