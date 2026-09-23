// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoginView from "./LoginView.vue";

const { get, login } = vi.hoisted(() => ({ get: vi.fn(), login: vi.fn() }));

vi.mock("../api", () => ({ apiClient: { GET: get } }));
vi.mock("../session", () => ({
  login,
  session: { scopeDenied: false },
  startGithubLogin: vi.fn(),
}));
vi.mock("../router", () => ({ router: { replace: vi.fn() } }));

describe("operator login view", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("shows the password form only when the backend advertises it", async () => {
    get.mockResolvedValue({ data: { methods: ["GITHUB"] } });
    const wrapper = mount(LoginView, {
      global: { mocks: { $route: { query: {} } } },
    });
    await flushPromises();
    expect(wrapper.find('input[type="password"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("Pokračovat přes GitHub");
  });

  it("submits advertised development credentials without showing them in errors", async () => {
    get.mockResolvedValue({ data: { methods: ["EMAIL_PASSWORD"] } });
    login.mockResolvedValue({
      ok: false,
      feedback: { message: "Neplatné údaje", retryAfterSeconds: null },
    });
    const wrapper = mount(LoginView, {
      global: { mocks: { $route: { query: {} } } },
    });
    await flushPromises();
    await wrapper.get('input[type="email"]').setValue("operator@example.test");
    await wrapper.get('input[type="password"]').setValue("a-secret-password");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(login).toHaveBeenCalledWith(
      "operator@example.test",
      "a-secret-password",
    );
    expect(wrapper.text()).not.toContain("a-secret-password");
  });
});
