import React, { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { request, validUser, loginError } from "./api.js";
function tomorrow() {
  return new Date(Date.now() + 86400000 + 9 * 3600000)
    .toISOString()
    .slice(0, 10);
}
const HOURLY_PRICE = 10000;
const money = (value) => value.toLocaleString("ko-KR") + "원";
function grouped(rows) {
  const groups = [];
  for (const row of [...rows].sort(
    (a, b) => a.status.localeCompare(b.status) || a.slot.localeCompare(b.slot),
  )) {
    const last = groups.at(-1);
    if (
      last &&
      last.status === row.status &&
      last.items[0].slot.slice(0, 10) === row.slot.slice(0, 10) &&
      Date.parse(row.slot) - Date.parse(last.items.at(-1).slot) === 3600000
    )
      last.items.push(row);
    else groups.push({ status: row.status, items: [row] });
  }
  return groups;
}
function range(items) {
  const end =
    String(Number(items.at(-1).slot.slice(11, 13)) + 1).padStart(2, "0") +
    ":00";
  return items[0].slot.slice(11, 16) + "–" + end;
}
function Confirmation({ title, children, confirm, onConfirm, onClose, busy }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id="confirm-title">{title}</h2>
      <div className="modal-copy">{children}</div>
      <div className="modal-actions">
        <button autoFocus disabled={busy} onClick={onClose}>
          돌아가기
        </button>
        <button className="primary" disabled={busy} onClick={onConfirm}>
          {busy ? "처리 중…" : confirm}
        </button>
      </div>
    </dialog>
  );
}
function App() {
  const [loginErrors, setLoginErrors] = useState({});
  const [user, setUser] = useState(null),
    [date, setDate] = useState(tomorrow),
    [slots, setSlots] = useState([]),
    [bookings, setBookings] = useState([]),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState([]),
    [modal, setModal] = useState(null),
    [modalError, setModalError] = useState("");
  const [sessionState, setSessionState] = useState("checking");
  const [loggingOut, setLoggingOut] = useState(false);
  const authPending = useRef(false);
  const epoch = useRef(0);

  function resetSession(notice = "") {
    epoch.current += 1;
    setUser(null);
    setSlots([]);
    setBookings([]);
    setSelected([]);
    setModal(null);
    setModalError("");
    setLoginErrors({});
    setBusy(false);
    setDate(tomorrow());
    setMessage(notice);
    setSessionState("ready");
  }
  async function api(path, method = "GET", body) {
    const version = epoch.current;
    try {
      const data = await request(path, method, body);
      if (version !== epoch.current) throw new Error("stale request");
      return data;
    } catch (error) {
      if (version === epoch.current && error.status === 401) {
        resetSession("로그인이 필요합니다. 다시 로그인해 주세요.");
      }
      throw error;
    }
  }
  async function checkSession() {
    if (authPending.current) return;
    authPending.current = true;
    setSessionState("checking");
    setMessage("");
    try {
      const data = await request("/me", "GET", undefined, 10000);
      if (!validUser(data)) throw new Error("invalid user");
      setUser(data);
      setSessionState("ready");
    } catch (error) {
      if (error.status === 401) resetSession();
      else {
        setSessionState("error");
        setMessage("로그인 상태를 확인하지 못했습니다. 다시 시도해 주세요.");
      }
    } finally {
      authPending.current = false;
    }
  }
  async function logout() {
    if (authPending.current) return;
    authPending.current = true;
    setLoggingOut(true);
    const version = epoch.current;
    try {
      const data = await request("/logout", "POST", undefined, 10000);
      if (data?.ok !== true) throw new Error("invalid logout response");
      if (version === epoch.current) resetSession();
    } catch {
      if (version === epoch.current) setMessage("로그아웃 완료를 확인하지 못했습니다. 다시 시도해 주세요.");
    } finally {
      authPending.current = false;
      setLoggingOut(false);
    }
  }
  async function refresh() {
    const [s, b] = await Promise.all([
      api("/slots?date=" + date),
      api("/bookings"),
    ]);
    setSlots(s);
    setSelected((current) =>
      current.filter((slot) =>
        s.some((item) => item.slot === slot && item.available),
      ),
    );
    setBookings(b);
  }
  useEffect(() => {
    checkSession();
  }, []);
  useEffect(() => {
    if (!user) return;
    let active = true;
    const version = epoch.current;
    setSlots([]);
    Promise.all([api("/slots?date=" + date), api("/bookings")])
      .then(([s, b]) => {
        if (active && version === epoch.current) {
          setSlots(s);
          setBookings(b);
        }
      })
      .catch((e) => {
        if (active && version === epoch.current) setMessage(e.message);
      });
    return () => {
      active = false;
    };
  }, [user, date]);
  async function action(fn, success) {
    const version = epoch.current;
    setBusy(true);
    setMessage("");
    try {
      await fn();
      if (version !== epoch.current) return;
      setMessage(success);
      try {
        await refresh();
      } catch {
        if (version === epoch.current) setMessage(success + " 목록을 새로고침해 주세요.");
      }
    } catch (e) {
      if (version === epoch.current) setMessage(e.message);
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  }
  return (
    <>
      <header>
        <a className="brand" href="/">
          틈<span>STUDY ROOM</span>
        </a>
        <span className="badge">로컬 데모</span>
        {user && (
          <div>
            {user.name} · {user.role === "admin" ? "관리자" : "멤버"}{" "}
            <button
              disabled={loggingOut}
              onClick={logout}
            >
              로그아웃
            </button>
          </div>
        )}
      </header>
      <main>
        <p className="eyebrow">A LITTLE SPACE, A LOT OF FOCUS</p>
        <h1>
          집중할 시간이
          <br />
          필요할 때, 틈.
        </h1>
        <p className="intro">나만의 몰입을 위한 작은 공간을 예약하세요.</p>
        <p role="status" className="notice">
          {message}
        </p>
        {sessionState !== "ready" ? (
          <section aria-label="로그인 상태 확인">
            {sessionState === "checking" ? <p>로그인 상태 확인 중…</p> :
              <button onClick={checkSession}>로그인 상태 다시 확인</button>}
          </section>
        ) : !user ? (
          <section className="login">
            <h2>반가워요</h2>
            <p>데모 계정으로 예약을 시작하세요.</p>
            <form
              noValidate
              onSubmit={async (e) => {
                e.preventDefault();
                if (authPending.current) return;
                setMessage("");
                const form = new FormData(e.currentTarget);
                const errors = {};
                if (!String(form.get("username") || "").trim())
                  errors.username = "계정을 입력해주세요.";
                if (!form.get("password"))
                  errors.password = "비밀번호를 입력해주세요.";
                setLoginErrors(errors);
                if (Object.keys(errors).length) {
                  e.currentTarget.elements.namedItem(
                    errors.username ? "username" : "password",
                  ).focus();
                  return;
                }
                authPending.current = true;
                setBusy(true);
                try {
                  const data = await request("/login", "POST", Object.fromEntries(form), 10000);
                  if (!validUser(data)) throw new Error("invalid user");
                  epoch.current += 1;
                  setUser(data);
                } catch (err) {
                  setMessage(loginError(err));
                } finally {
                  authPending.current = false;
                  setBusy(false);
                }
              }}
            >
              <div className="login-field">
                <label htmlFor="login-username">계정</label>
                <input
                  id="login-username"
                  name="username"
                  type="text"
                  placeholder="alice, bob, admin"
                  autoComplete="username"
                  aria-invalid={!!loginErrors.username}
                  aria-describedby={loginErrors.username ? "username-error" : undefined}
                  onChange={(e) => {
                    if (e.target.value.trim())
                      setLoginErrors((current) => ({ ...current, username: undefined }));
                  }}
                  required
                />
                {loginErrors.username && (
                  <span id="username-error" className="field-error" role="alert">
                    {loginErrors.username}
                  </span>
                )}
              </div>
              <div className="login-field">
                <label htmlFor="login-password">비밀번호</label>
                <input
                  id="login-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  aria-invalid={!!loginErrors.password}
                  aria-describedby={loginErrors.password ? "password-error" : undefined}
                  onChange={(e) => {
                    if (e.target.value)
                      setLoginErrors((current) => ({ ...current, password: undefined }));
                  }}
                  required
                />
                {loginErrors.password && (
                  <span id="password-error" className="field-error" role="alert">
                    {loginErrors.password}
                  </span>
                )}
              </div>
              <button className="primary" disabled={busy}>
                {busy ? "로그인 중…" : "로그인"}
              </button>
            </form>
            <small>학습용 계정 · 비밀번호 demo1234</small>
          </section>
        ) : (
          <div className="columns">
            <section>
              <div className="room">
                <span>ROOM 01</span>
                <h2>포커스 룸</h2>
                <p>최대 4인 · 화이트보드 · Wi-Fi</p>
              </div>
              <div className="panel">
                <h2>언제 이용하시나요?</h2>
                <label>
                  예약 날짜
                  <input
                    type="date"
                    value={date}
                    disabled={busy}
                    onChange={(e) => {
                      const next = e.target.value;
                      if (!next || next === date) return;
                      if (selected.length)
                        setModal({ type: "date", date: next });
                      else {
                        setDate(next);
                        setMessage("");
                      }
                    }}
                  />
                </label>
                <p className="muted">한국 시간(KST) · 1시간 단위 · 30일 이내</p>
                <div className="slots">
                  {slots.map((s) => (
                    <div key={s.slot}>
                      <button
                        disabled={busy || !s.available}
                        aria-label={s.slot.slice(11, 16) + " 선택"}
                        aria-pressed={selected.includes(s.slot)}
                        onClick={() =>
                          setSelected((current) =>
                            current.includes(s.slot)
                              ? current.filter((slot) => slot !== s.slot)
                              : [...current, s.slot].sort(),
                          )
                        }
                      >
                        <strong>{s.slot.slice(11, 16)}</strong>
                        <small>
                          {s.available
                            ? selected.includes(s.slot)
                              ? "선택됨"
                              : "예약 가능"
                            : s.blocked
                              ? "잠금"
                              : "예약 불가"}
                        </small>
                      </button>
                      {user.role === "admin" && (
                        <button
                          disabled={busy}
                          className="lock"
                          aria-label={
                            s.slot.slice(11, 16) +
                            (s.blocked ? " 잠금 해제" : " 잠금")
                          }
                          onClick={() =>
                            action(
                              () =>
                                api("/admin/slots", "PUT", {
                                  slot: s.slot,
                                  blocked: !s.blocked,
                                }),
                              "시간 설정을 변경했습니다.",
                            )
                          }
                        >
                          {s.blocked ? "잠금 해제" : "잠금"}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <section className="summary" aria-label="예약 요약">
                  <h3>예약 내용 확인</h3>
                  {selected.length ? (
                    <>
                      <dl>
                        <div>
                          <dt>이용 공간</dt>
                          <dd>포커스 룸</dd>
                        </div>
                        <div>
                          <dt>예약 일시</dt>
                          <dd>
                            {date}
                            {grouped(
                              selected.map((slot) => ({
                                slot,
                                status: "selected",
                              })),
                            ).map((g) => (
                              <span
                                className="time-range"
                                key={g.items[0].slot}
                              >
                                {range(g.items)}
                              </span>
                            ))}
                          </dd>
                        </div>
                        <div>
                          <dt>총 예약 시간</dt>
                          <dd>{selected.length}시간</dd>
                        </div>
                        <div>
                          <dt>시간당 요금</dt>
                          <dd>{money(HOURLY_PRICE)}</dd>
                        </div>
                        <div className="total">
                          <dt>결제 금액</dt>
                          <dd>{money(selected.length * HOURLY_PRICE)}</dd>
                        </div>
                      </dl>
                      <p className="muted">
                        데모 요금이며 실제 결제는 발생하지 않습니다.
                      </p>
                    </>
                  ) : (
                    <p className="muted">
                      이용할 시간을 선택하면 예약 내용과 금액을 확인할 수
                      있어요.
                    </p>
                  )}
                  <button
                    className="primary reserve"
                    disabled={busy || !selected.length}
                    onClick={() =>
                      action(async () => {
                        await api("/bookings", "POST", { slots: selected });
                        setSelected([]);
                      }, "예약이 완료되었습니다.")
                    }
                  >
                    {busy ? "처리 중…" : "예약 확정하기"}
                  </button>
                </section>
              </div>
            </section>
            <section className="panel history">
              <h2>내 예약</h2>
              <p className="muted">다가오는 집중 시간을 확인하세요.</p>
              {bookings.length === 0 ? (
                <div className="empty">
                  아직 예약이 없어요.
                  <br />
                  <small>원하는 시간을 선택해 보세요.</small>
                </div>
              ) : (
                grouped(bookings)
                  .sort((a, b) =>
                    b.items[0].slot.localeCompare(a.items[0].slot),
                  )
                  .map((g) => (
                    <article
                      key={g.items.map((b) => b.id).join("-")}
                      className={g.status === "cancelled" ? "cancelled" : ""}
                    >
                      <span
                        className={
                          g.status === "confirmed" ? "confirmed" : "muted"
                        }
                      >
                        {g.status === "confirmed" ? "예약 확정" : "취소됨"}
                      </span>
                      <h3 className="booking-details">
                        {g.items[0].slot.slice(0, 10)} · {range(g.items)}
                      </h3>
                      <p className="booking-details">
                        포커스 룸 · 총 {g.items.length}시간
                      </p>
                      {g.status === "confirmed" && (
                        <button
                          disabled={busy}
                          onClick={() => {
                            setModalError("");
                            setModal({ type: "cancel", group: g });
                          }}
                        >
                          예약 취소
                        </button>
                      )}
                    </article>
                  ))
              )}
            </section>
          </div>
        )}
        {modal && (
          <Confirmation
            title={
              modal.type === "date"
                ? "날짜를 변경할까요?"
                : "예약을 취소할까요?"
            }
            confirm={
              modal.type === "date" ? "선택 초기화하고 이동" : "취소하기"
            }
            busy={busy}
            onClose={() => {
              setModal(null);
              setModalError("");
            }}
            onConfirm={async () => {
              if (modal.type === "date") {
                setSelected([]);
                setDate(modal.date);
                setMessage("");
                setModal(null);
                return;
              }
              const version = epoch.current;
              setBusy(true);
              setModalError("");
              try {
                await api("/bookings/cancel", "POST", {
                  ids: modal.group.items.map((b) => b.id),
                });
                setModal(null);
                setMessage("예약을 취소했습니다.");
                try {
                  await refresh();
                } catch {
                  if (version === epoch.current) setMessage("예약을 취소했습니다. 목록을 새로고침해 주세요.");
                }
              } catch (e) {
                if (version === epoch.current) setModalError(e.message);
              } finally {
                if (version === epoch.current) setBusy(false);
              }
            }}
          >
            {modal.type === "date" ? (
              <p>
                선택한 {selected.length}시간이 초기화됩니다. {modal.date} 날짜로
                이동할까요?
              </p>
            ) : (
              <>
                <p>
                  {modal.group.items[0].slot.slice(0, 10)} ·{" "}
                  {range(modal.group.items)}
                </p>
                <p>포커스 룸 · 총 {modal.group.items.length}시간</p>
                <p>이 예약 내역의 모든 시간이 취소됩니다.</p>
              </>
            )}
            {modalError && <p role="alert">{modalError}</p>}
          </Confirmation>
        )}
        <footer>
          틈 / MINI BOOKING<span>QA AUTOMATION STUDY · 01</span>
        </footer>
      </main>
    </>
  );
}
createRoot(document.getElementById("root")).render(<App />);
