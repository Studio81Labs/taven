// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import PortfolioGallery from "./PortfolioGallery.vue";
import type { PortfolioItem } from "../../utils/portfolio-display";

const fixtureItems: PortfolioItem[] = [
  {
    publicId: "D-0142",
    title: "Fixture A",
    category: "Kategorie A",
    material: "Materiál A",
    description: "Popis pouze pro izolovaný test.",
    manufacturing: {
      color: "Černá",
      quantity: 2,
      quality: "Standard",
      revision: "A",
    },
    image: {
      src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' />",
      alt: "Testovací geometrie A",
      width: 800,
      height: 600,
    },
  },
  {
    publicId: "D-0139",
    title: "Fixture B",
    category: "Kategorie B",
    material: "Materiál B",
    image: {
      src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' />",
      alt: "Testovací geometrie B",
      width: 800,
      height: 600,
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
    expect(wrapper.get(".portfolio-card img").attributes("width")).toBe("800");
    expect(wrapper.get(".portfolio-card__public-id").text()).toBe("D-0142");
    expect(wrapper.get(".portfolio-card__body").text()).toContain("Černá");

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
    expect(wrapper.get(".portfolio-detail").text()).toContain("D-0142");
    expect(wrapper.get(".portfolio-detail").text()).toContain("Standard");
    await wrapper.get(".portfolio-detail button").trigger("click");
    expect(wrapper.find(".portfolio-detail").exists()).toBe(false);

    await wrapper
      .get(".portfolio-filters button:nth-child(1)")
      .trigger("click");
    expect(wrapper.findAll(".portfolio-card")).toHaveLength(2);
    expect(
      wrapper.findAll(".portfolio-card__body > p:not(.public-page__index)"),
    ).toHaveLength(1);
  });

  it("replaces missing and failed images in cards and detail without hiding metadata", async () => {
    const wrapper = mount(PortfolioGallery, {
      props: {
        items: [
          fixtureItems[0]!,
          {
            ...fixtureItems[1]!,
            image: { ...fixtureItems[1]!.image, src: "" },
          },
        ],
      },
    });
    expect(wrapper.findAll(".portfolio-image-fallback")).toHaveLength(1);
    expect(wrapper.text()).toContain("Fixture B");

    await wrapper.get(".portfolio-card img").trigger("error");
    expect(wrapper.findAll(".portfolio-image-fallback")).toHaveLength(2);
    expect(wrapper.text()).toContain("Fixture A");

    await wrapper.get(".portfolio-card button").trigger("click");
    expect(wrapper.get(".portfolio-detail h2").text()).toBe("Fixture A");
    expect(
      wrapper
        .get(".portfolio-detail .portfolio-image-fallback")
        .attributes("aria-label"),
    ).toContain("Fixture A");
  });

  it("moves focus to a distant opened detail and restores the card trigger on close", async () => {
    const items = Array.from({ length: 8 }, (_, index) => ({
      ...fixtureItems[0]!,
      publicId: `D-${index}`,
      title: `Fixture ${index}`,
    }));
    const wrapper = mount(PortfolioGallery, {
      props: { items },
      attachTo: document.body,
    });
    const trigger = wrapper.findAll<HTMLButtonElement>(
      ".portfolio-card button",
    )[0]!;
    await trigger.trigger("click");
    expect(document.activeElement).toBe(
      wrapper.get(".portfolio-detail").element,
    );
    await wrapper.get(".portfolio-detail button").trigger("click");
    expect(document.activeElement).toBe(trigger.element);
    wrapper.unmount();
  });
});
