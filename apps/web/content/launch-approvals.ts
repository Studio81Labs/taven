export type CommercialContentStatus = "pending-approval" | "approved";

export const commercialContentApproval = {
  status: "pending-approval" as CommercialContentStatus,
} as const;
