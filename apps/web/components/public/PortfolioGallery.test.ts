// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import PortfolioGallery from "./PortfolioGallery.vue";
import type { PortfolioItem } from "../../utils/portfolio-display";

const fixtureItems: PortfolioItem[] = [
  {
    id: "fixture-a",
    title: "Fixture A",
    category: "Kategorie A",
    material: "Materiál A",
    description: "Popis pouze pro izolovaný test.",
    image: {
      src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' />",
      alt: "Testovací geometrie A",
    },
  },
  {
    id: "fixture-b",
    title: "Fixture B",
    category: "Kategorie B",
    material: "Materiál B",
    description: "Druhý izolovaný test.",
    image: {
      src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' />",
      alt: "Testovací geometrie B",
    },
  },
];

describe("PortfolioGallery presentation", () => {
  it("renders an honest live empty state without cards or filters", () => {
    const wrapper = mount(PortfolioGallery, { props: { items: [] } });
    expect(wrapper.text()).toContain("Portfolio je zatím prázdné");
    expect(wrapper.findAll(".portfolio-card")).toHaveLength(0);
    expect(wrapper.find(".portfolio-filters").exists()).toBe(false);
  });

  it("renders an error instead of a stale gallery", () => {
    const wrapper = mount(PortfolioGallery, {
      props: { items: fixtureItems, error: "Zkuste to později." },
    });
    expect(wrapper.attributes("role")).toBe("alert");
    expect(wrapper.text()).toContain("Zkuste to později.");
    expect(wrapper.findAll(".portfolio-card")).toHaveLength(0);
  });

  it("filters approved-style fixture cards and opens a matching detail", async () => {
    const wrapper = mount(PortfolioGallery, { props: { items: fixtureItems } });
    expect(wrapper.findAll(".portfolio-card")).toHaveLength(2);
    expect(
      wrapper
        .findAll(".portfolio-card img")
        .map((image) => image.attributes("alt")),
    ).toEqual(["Testovací geometrie A", "Testovací geometrie B"]);

    await wrapper
      .get(".portfolio-filters button:nth-child(2)")
      .trigger("click");
    expect(wrapper.findAll(".portfolio-card")).toHaveLength(1);
    expect(wrapper.find(".portfolio-card").text()).toContain("Fixture A");
    expect(
      wrapper
        .get(".portfolio-filters button:nth-child(2)")
        .attributes("aria-pressed"),
    ).toBe("true");

    await wrapper.get(".portfolio-card button").trigger("click");
    expect(wrapper.get(".portfolio-detail h2").text()).toBe("Fixture A");
    await wrapper.get(".portfolio-detail button").trigger("click");
    expect(wrapper.find(".portfolio-detail").exists()).toBe(false);

    await wrapper
      .get(".portfolio-filters button:nth-child(1)")
      .trigger("click");
    expect(wrapper.findAll(".portfolio-card")).toHaveLength(2);
  });
});
