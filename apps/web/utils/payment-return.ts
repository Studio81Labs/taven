export type CheckoutPaymentStatus =
  | "CREATED"
  | "PENDING"
  | "CAPTURED"
  | "FAILED"
  | "VOIDED"
  | "REFUND_PENDING"
  | "PARTIALLY_REFUNDED"
  | "REFUNDED";

export type PaymentReturnKind = "success" | "cancelled" | "pending";
export type PaymentReturnTone = "success" | "pending" | "failure" | "refund";

export interface PaymentReturnPresentation {
  description: string;
  label: string;
  refreshable: boolean;
  restartable: boolean;
  title: string;
  tone: PaymentReturnTone;
}

export type PaymentRestartMode = "PAYMENT" | "QUOTE" | null;

export function paymentRestartMode(
  status: CheckoutPaymentStatus,
): PaymentRestartMode {
  if (status === "FAILED") return "PAYMENT";
  if (status === "VOIDED") return "QUOTE";
  return null;
}

export function initialPaymentReturnPresentation(
  kind: PaymentReturnKind,
): PaymentReturnPresentation {
  if (kind === "cancelled") {
    return {
      label: "NÁVRAT Z PLATBY",
      title: "Ověřujeme stav platby.",
      description:
        "Návrat od poskytovatele sám o sobě nepotvrzuje zrušení. Načítáme ověřený stav objednávky.",
      tone: "pending",
      refreshable: false,
      restartable: false,
    };
  }
  if (kind === "pending") {
    return {
      label: "PLATBA SE ZPRACOVÁVÁ",
      title: "Čekáme na potvrzení platby.",
      description:
        "Bankovní potvrzení může chvíli trvat. Stav načítáme přímo z objednávky.",
      tone: "pending",
      refreshable: false,
      restartable: false,
    };
  }
  return {
    label: "NÁVRAT Z PLATBY",
    title: "Ověřujeme potvrzení platby.",
    description:
      "Výsledek nepřebíráme z adresy prohlížeče. Čekáme na ověřené potvrzení poskytovatele.",
    tone: "pending",
    refreshable: false,
    restartable: false,
  };
}

export function paymentReturnPresentation(
  status: CheckoutPaymentStatus,
): PaymentReturnPresentation {
  if (status === "CAPTURED") {
    return {
      label: "PLATBA PŘIJATA",
      title: "Platba byla potvrzena.",
      description:
        "Objednávku jsme přijali a připravujeme ji k výrobě. Další informace pošleme elektronicky.",
      tone: "success",
      refreshable: false,
      restartable: false,
    };
  }
  if (status === "FAILED") {
    return {
      label: "PLATBA NEDOKONČENA",
      title: "Platba nebyla dokončena.",
      description:
        "Objednávka nebyla předána do výroby. Vraťte se ke kalkulaci a vytvořte nový platební pokus.",
      tone: "failure",
      refreshable: true,
      restartable: true,
    };
  }
  if (status === "VOIDED") {
    return {
      label: "OBJEDNÁVKA ZRUŠENA",
      title: "Platební pokus byl zrušen.",
      description:
        "Objednávka nebyla předána do výroby. Pro další objednání začněte novou kalkulaci.",
      tone: "failure",
      refreshable: false,
      restartable: true,
    };
  }
  if (status === "REFUNDED") {
    return {
      label: "PLATBA VRÁCENA",
      title: "Vrácení platby bylo dokončeno.",
      description:
        "Peníze jsme odeslali zpět prostřednictvím poskytovatele platby. Doba připsání závisí na bance.",
      tone: "refund",
      refreshable: false,
      restartable: false,
    };
  }
  if (status === "REFUND_PENDING" || status === "PARTIALLY_REFUNDED") {
    return {
      label: "VRÁCENÍ PLATBY",
      title: "Platbu vracíme.",
      description:
        "Objednávku jsme do výroby nepředali. Stav vrácení platby můžete znovu načíst.",
      tone: "refund",
      refreshable: true,
      restartable: false,
    };
  }
  return {
    label: "OVĚŘUJEME PLATBU",
    title: "Čekáme na potvrzení platby.",
    description:
      "Poskytovatel zatím nepotvrdil konečný výsledek. Stránka stav průběžně obnovuje.",
    tone: "pending",
    refreshable: true,
    restartable: false,
  };
}
