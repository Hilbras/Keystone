import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { sendSmsOtp, verifySmsOtp, markPhoneVerified } from "../services/smsOtp.js";

const SendSchema = z.object({
  phoneNumber: z.string().min(5).max(32),
});

const VerifySchema = z.object({
  phoneNumber: z.string().min(5).max(32),
  code: z.string().min(4).max(8),
});

export default async function smsOtpRoutes(app: FastifyInstance) {
  app.post(
    "/sms-otp/send",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const body = SendSchema.parse(request.body);

      await sendSmsOtp(user, body.phoneNumber);
      await request.audit("sms_otp_sent", { userId: user.id, phoneNumber: body.phoneNumber });

      return { success: true };
    }
  );

  app.post(
    "/sms-otp/verify",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const body = VerifySchema.parse(request.body);

      const valid = await verifySmsOtp(user.id, body.code);
      if (!valid) {
        await request.audit("sms_otp_verify_failed", { userId: user.id });
        return reply.status(400).send({ error: "Invalid or expired code" });
      }

      await markPhoneVerified(user.id, body.phoneNumber);
      await request.audit("sms_otp_verified", { userId: user.id, phoneNumber: body.phoneNumber });

      return { success: true };
    }
  );
}
