// @ts-check
import {test, expect} from '@playwright/test';

function loginElements(page){
  return {
    accountField: page.locator(".login-field").filter({ has: page.getByLabel("계정", {exact: true}) }),
    accountInput: page.getByLabel("계정"),
    passwordField: page.locator(".login-field").filter({ has: page.getByLabel("비밀번호", {exact: true}) }),
    passwordInput: page.getByLabel("비밀번호"),
    loginButton: page.getByRole("button", { name: "로그인", exact: true })
  };
};

// Playwright의 page fixture는 테스트마다 새 BrowserContext를 제공합니다.
test("[TC-L-01] 로그인 입력란 초기값은 비어 있다", async ({ page }) => {
  const { accountInput, passwordInput } = loginElements(page);
  await page.goto("/");

  await expect(accountInput).toHaveValue("");
  await expect(passwordInput).toHaveValue("");
});

for (const scenario of [
  { name: "A: 계정·비밀번호 모두 미입력", password: "" },
  { name: "B: 계정만 미입력", password: "demo1234" },
]) {
  test(`[TC-L-02] ${scenario.name} 시 오류 안내·요청 차단·오류 해제`, async ({ page }) => {
    const { accountField, accountInput, passwordField, passwordInput, loginButton } = loginElements(page);
    const accountError = accountField.getByText("계정을 입력해주세요.", { exact: true });
    const passwordError = passwordField.getByText("비밀번호를 입력해주세요.", { exact: true });
    const loginRequests = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/login") {
        loginRequests.push(request);
      }
    });

    await page.goto("/");
    await passwordInput.fill(scenario.password);
    // 네이티브 필수 입력 팝업 대신 애플리케이션의 오류 안내를 사용합니다.
    await expect(page.locator("form")).toHaveAttribute("novalidate", "");
    await loginButton.click();

    await expect(accountError).toBeVisible();
    await expect(accountInput).toBeFocused();
    await expect(accountInput).toHaveAttribute("aria-invalid", "true");
    if (!scenario.password) {
      await expect(passwordError).toBeVisible();
      await expect(passwordInput).toHaveAttribute("aria-invalid", "true");
    } else {
      await expect(passwordError).toHaveCount(0);
      await expect(passwordInput).toHaveAttribute("aria-invalid", "false");
    }
    expect(loginRequests).toHaveLength(0);

    await accountInput.fill("alice");
    await expect(accountError).toHaveCount(0);
    await expect(accountInput).toHaveAttribute("aria-invalid", "false");
    if (!scenario.password) {
      // 계정 오류를 해제해도 아직 비어 있는 비밀번호 오류는 유지되어야 합니다.
      await expect(passwordError).toBeVisible();
      await expect(passwordInput).toHaveAttribute("aria-invalid", "true");
      await passwordInput.fill("demo1234");
      await expect(passwordError).toHaveCount(0);
      await expect(passwordInput).toHaveAttribute("aria-invalid", "false");
    }
    await expect(loginButton).toBeVisible();
    await expect(page.getByRole("button", { name: "로그아웃", exact: true })).toHaveCount(0);
    expect(loginRequests).toHaveLength(0);
  });
}

// 조합마다 독립 테스트로 실행하고, 상세 CSS 대신 오류 상태를 검증합니다.
for (const scenario of [
  { id: "TC-L-04", name: "비밀번호 미입력", username: "alice", password: "", field: "password" },
  { id: "TC-L-06", name: "공백만 있는 계정", username: "   ", password: "demo1234", field: "username" },
]) {
  test(`[${scenario.id}] ${scenario.name} 오류 안내·요청 차단·오류 해제`, async ({ page }) => {
    const { accountField, accountInput, passwordField, passwordInput, loginButton } = loginElements(page);
    const accountError = accountField.getByText("계정을 입력해주세요.", { exact: true });
    const passwordError = passwordField.getByText("비밀번호를 입력해주세요.", { exact: true });
    const isPasswordError = scenario.field === "password";
    const invalidInput = isPasswordError ? passwordInput : accountInput;
    const validInput = isPasswordError ? accountInput : passwordInput;
    const error = isPasswordError ? passwordError : accountError;
    const otherError = isPasswordError ? accountError : passwordError;
    const loginRequests = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/login") {
        loginRequests.push(request);
      }
    });

    await page.goto("/");
    await accountInput.fill(scenario.username);
    await passwordInput.fill(scenario.password);
    await expect(page.locator("form")).toHaveAttribute("novalidate", "");
    await loginButton.click();

    await expect(error).toBeVisible();
    await expect(invalidInput).toBeFocused();
    await expect(invalidInput).toHaveAttribute("aria-invalid", "true");
    await expect(otherError).toHaveCount(0);
    await expect(validInput).toHaveAttribute("aria-invalid", "false");
    expect(loginRequests).toHaveLength(0);

    await invalidInput.fill(isPasswordError ? "demo1234" : "alice");
    await expect(error).toHaveCount(0);
    await expect(invalidInput).toHaveAttribute("aria-invalid", "false");
    await expect(loginButton).toBeVisible();
    await expect(page.getByRole("button", { name: "로그아웃", exact: true })).toHaveCount(0);
    expect(loginRequests).toHaveLength(0);
  });
}
