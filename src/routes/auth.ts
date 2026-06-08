import { Router, type IRouter } from "express";
import { authMiddleware } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import { toErrorResponse } from "../lib/errors";
import { loginSchema, signupSchema } from "../validators/auth";
import * as authService from "../services/authService";

const router: IRouter = Router();

router.post("/signup", validateBody(signupSchema), async (req, res) => {
  try {
    const result = await authService.signup(req.body);
    res.status(201).json({
      message: "Account created successfully",
      user: result.user,
      token: result.token,
    });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    res.status(status).json(body);
  }
});

router.post("/login", validateBody(loginSchema), async (req, res) => {
  try {
    const result = await authService.login(req.body);
    res.json({
      message: "Login successful",
      user: result.user,
      token: result.token,
    });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    res.status(status).json(body);
  }
});

router.post("/logout", authMiddleware, (_req, res) => {
  res.json({ message: "Logged out successfully" });
});

router.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = await authService.getUserById(req.user!.userId);
    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }
    res.json({ user });
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    res.status(status).json(body);
  }
});

export default router;
