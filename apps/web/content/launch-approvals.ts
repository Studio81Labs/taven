export type CommercialContentStatus = "pending-approval" | "approved";

export const commercialContentApproval = {
  // The current commercial configuration is owner-approved for isolated
  // development/staging exercises. Public activation still requires the
  // runtime switch and the backend's effective legal-document gate.
  status: "approved" as CommercialContentStatus,
} as const;
