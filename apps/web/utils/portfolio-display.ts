export interface PortfolioItem {
  publicId: string;
  title: string;
  category: string;
  material: string;
  description?: string;
  manufacturing?: {
    color?: string;
    quantity?: number;
    quality?: string;
    revision?: string;
  };
  image: { src: string; alt: string; width: number; height: number };
}

export function portfolioCategories(items: readonly PortfolioItem[]): string[] {
  return [...new Set(items.map((item) => item.category))];
}

export function visiblePortfolioItems(
  items: readonly PortfolioItem[],
  category: string | null,
): readonly PortfolioItem[] {
  return category ? items.filter((item) => item.category === category) : items;
}
