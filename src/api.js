// Keep HTTP failures distinct from transport, timeout and response-format errors.
export class ApiError extends Error {
  constructor(message, kind, status) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export async function request(path, method = "GET", body, timeout = 0) {
  const controller = new AbortController();
  let timer;
  const operation = (async () => {
    let response;
    try {
      response = await fetch("/api" + path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      throw new ApiError("연결에 문제가 발생했습니다.", "network");
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new ApiError("응답을 확인할 수 없습니다.", "format", response.status);
    }
    if (!response.ok) {
      throw new ApiError(data?.error || "요청을 처리하지 못했습니다.", "http", response.status);
    }
    return data;
  })();
  try {
    // A race also ignores late results from a transport that cannot be aborted.
    return await (timeout ? Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new ApiError("응답 시간이 초과되었습니다.", "timeout"));
          controller.abort();
        }, timeout);
      }),
    ]) : operation);
  } finally {
    clearTimeout(timer);
  }
}

export function validUser(value) {
  return value && ["alice", "bob", "admin"].includes(value.name)
    && value.role === (value.name === "admin" ? "admin" : "user");
}

export function loginError(error) {
  if (error.kind === "timeout") return "응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.";
  if (error.kind === "network") return "연결에 문제가 발생했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.";
  if (error.status === 401) return "계정 또는 비밀번호를 확인해 주세요.";
  return "로그인 처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.";
}
