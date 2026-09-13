import { SetMetadata } from "@nestjs/common";

export const ALLOW_NODE_FREE_ADMIN_KEY = "allow-node-free-admin";

/**
 * Allows an administrator session without any assigned node scope to access
 * the decorated route or controller. Used for seller-global capabilities like
 * legal document management, legal audit inspection, and session management.
 */
export const AllowNodeFreeAdmin = () =>
  SetMetadata(ALLOW_NODE_FREE_ADMIN_KEY, true);
