export interface PortfolioItem {
  id: string;
  title: string;
  category: string;
  material: string;
  description: string;
  image: { src: string; alt: string };
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
