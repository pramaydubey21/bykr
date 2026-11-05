/**
 * Auth.js v5 configuration: credentials provider, Argon2id verification,
 * JWT session carrying the user id and roles (read from user_role/app_role).
 *
 * There is deliberately no middleware.ts: middleware runs on the edge runtime,
 * which cannot load pg or the native argon2 binding. Pages protect themselves
 * with requireUserId() / requireAdmin() from lib/auth/session.ts.
 */
import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import { findUserForSignIn } from "@/lib/auth/users";
import { dummyHash, verifyPassword } from "@/lib/auth/password";

declare module "next-auth" {
  interface User {
    roles?: string[];
  }
  interface Session {
    user: { id: string; roles: string[] } & DefaultSession["user"];
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    uid?: string;
    roles?: string[];
  }
}

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/signin" },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;

        const row = await findUserForSignIn(email);
        if (!row) {
          await verifyPassword(await dummyHash(), password); // equalise timing
          return null;
        }
        if (!(await verifyPassword(row.password_hash, password))) return null;

        return { id: String(row.user_id), name: row.full_name, email: row.email, roles: row.roles };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.uid = user.id;
        token.roles = user.roles ?? [];
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.uid ?? "";
      session.user.roles = token.roles ?? [];
      return session;
    },
  },
});
