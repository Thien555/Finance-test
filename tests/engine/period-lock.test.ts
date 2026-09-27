import { describe, expect, it } from "vitest";
import {
  actorError,
  describePeriod,
  firstLocked,
  isBalanced,
  isValidPeriod,
  laterLockedPeriods,
  type LockContext,
  lockKey,
  lockMsg,
  lockSummaryKey,
  LockTally,
  orderRowRefs,
  parseLockKey,
  type PeriodCounts,
  PeriodLocks,
  pendingIssues,
  periodOfDate,
  resolveLockTargets,
  unlockReasonError,
} from "@/lib/engine/period-lock";
import { PERIOD_RULES } from "@/lib/field-docs";
import { loadIndex } from "../helpers/fixtures";

const STRIPE = "ZeniroxPay - Stripe";
/** Tên cổng cố ý không có trong GatewayCompanyMapping (xem fixtures) */
const UNMAPPED = "Zenirox Pay SPF-BDU";

const cp = (ComCode: string, Period: string) => ({ ComCode, Period });
/** PeriodLocks từ danh sách "COMCODE|YYYYMM" */
const locksOf = (...keys: string[]) => new PeriodLocks(keys.map(parseLockKey));

describe("lockKey / PeriodLocks", () => {
  it("khóa chuẩn hóa trim + uppercase ComCode, trim kỳ", () => {
    expect(lockKey(" zeniroxpay ", " 202511 ")).toBe("ZENIROXPAY|202511");
    expect(lockKey("Ontario", "202512")).toBe("ONTARIO|202512");
    expect(lockKey(null, undefined)).toBe("|");
    expect(parseLockKey("ZENIROXPAY|202511")).toEqual(cp("ZENIROXPAY", "202511"));
    expect(describePeriod({ ComCode: " ontario", Period: "202511 " })).toBe("ONTARIO kỳ 202511");
    expect(lockSummaryKey("ORDERS", " zeniroxpay", "202511")).toBe("PERIOD_LOCKED|ORDERS|ZENIROXPAY|202511");
  });

  it("so khớp không phân biệt hoa/thường, bỏ trùng, bỏ dòng thiếu ComCode/kỳ; keys sort", () => {
    const locks = new PeriodLocks([
      cp("zeniroxpay ", "202511"),
      cp("ONTARIO", "202512"),
      cp("ZENIROXPAY", " 202511"),
      cp("", "202511"),
      cp("  ", "202511"),
      cp("ONTARIO", " "),
    ]);
    expect(locks.isEmpty).toBe(false);
    expect(locks.size).toBe(2);
    expect(locks.keys).toEqual(["ONTARIO|202512", "ZENIROXPAY|202511"]);

    expect(locks.isLocked({ ComCode: " ZeniroxPay", Period: "202511" })).toBe(true);
    expect(locks.isLocked({ ComCode: "ontario", Period: " 202512 " })).toBe(true);
    expect(locks.isLocked({ ComCode: "ZENIROXPAY", Period: "202512" })).toBe(false);
    expect(locks.isLocked({ ComCode: "ONTARIO", Period: "202511" })).toBe(false);
  });

  it("ComCode hoặc kỳ trống/null → không bao giờ khóa", () => {
    const locks = locksOf("ZENIROXPAY|202511");
    for (const ref of [
      { ComCode: null, Period: "202511" },
      { ComCode: undefined, Period: "202511" },
      { ComCode: "", Period: "202511" },
      { ComCode: "   ", Period: "202511" },
      { ComCode: "ZENIROXPAY", Period: null },
      { ComCode: "ZENIROXPAY", Period: undefined },
      { ComCode: "ZENIROXPAY", Period: "" },
      { ComCode: "ZENIROXPAY", Period: "  " },
    ]) {
      expect(locks.isLocked(ref)).toBe(false);
    }
  });

  it("NONE: rỗng, không khóa gì", () => {
    expect(PeriodLocks.NONE.isEmpty).toBe(true);
    expect(PeriodLocks.NONE.size).toBe(0);
    expect(PeriodLocks.NONE.keys).toEqual([]);
    expect(PeriodLocks.NONE.isLocked(cp("ZENIROXPAY", "202511"))).toBe(false);
    expect(new PeriodLocks([]).isEmpty).toBe(true);
  });

  it("periodsOf: kỳ khóa của đúng 1 công ty (không dính công ty trùng tiền tố), sort tăng dần", () => {
    const locks = locksOf("ZENIROXPAY|202512", "ZENIROXPAY|202510", "zeniroxpay|202511", "ZENIROX|202509", "ONTARIO|202601");
    expect(locks.periodsOf("zeniroxpay ")).toEqual(["202510", "202511", "202512"]);
    expect(locks.periodsOf("ZENIROX")).toEqual(["202509"]);
    expect(locks.periodsOf("ONTARIO")).toEqual(["202601"]);
    expect(locks.periodsOf("NEWCO")).toEqual([]);
  });

  it("periodOfDate / firstLocked", () => {
    expect(periodOfDate("2025-11-21")).toBe("202511");
    expect(periodOfDate(" 2025-12-01 10:30:00 ")).toBe("202512");
    expect(periodOfDate(null)).toBeNull();
    expect(periodOfDate(undefined)).toBeNull();
    expect(periodOfDate("  ")).toBeNull();

    const locks = locksOf("ONTARIO|202511");
    const refs = [cp("ZENIROXPAY", "202511"), cp("ONTARIO", "202511"), cp("ontario", "202511")];
    expect(firstLocked(locks, refs)).toBe(refs[1]);
    expect(firstLocked(locks, [cp("ZENIROXPAY", "202511")])).toBeUndefined();
    expect(firstLocked(PeriodLocks.NONE, refs)).toBeUndefined();
  });
});

describe("orderRowRefs", () => {
  const index = loadIndex();

  it("gồm ComCode theo GatewayCompanyMapping hiện tại và ComCode đang lưu, cùng kỳ FulfilledAt", () => {
    const row = { ComCode: "ONTARIO", PaymentGatewayName: STRIPE, FulfilledAt: "2025-11-21" };
    expect(orderRowRefs(row, index)).toEqual([cp("ZENIROXPAY", "202511"), cp("ONTARIO", "202511")]);
    // Tên cổng so khớp trim + uppercase như Build
    expect(orderRowRefs({ ...row, PaymentGatewayName: ` ${STRIPE.toLowerCase()} ` }, index)[0]).toEqual(cp("ZENIROXPAY", "202511"));
  });

  it("khóa kỳ của giá trị MỚI hoặc CŨ đều bắt được dòng", () => {
    const row = { ComCode: "ONTARIO", PaymentGatewayName: STRIPE, FulfilledAt: "2025-11-21" };
    expect(firstLocked(locksOf("ZENIROXPAY|202511"), orderRowRefs(row, index))).toEqual(cp("ZENIROXPAY", "202511"));
    expect(firstLocked(locksOf("ONTARIO|202511"), orderRowRefs(row, index))).toEqual(cp("ONTARIO", "202511"));
    expect(firstLocked(locksOf("ZENIROXPAY|202512", "ONTARIO|202512"), orderRowRefs(row, index))).toBeUndefined();
  });

  it("cổng chưa map, chưa lưu ComCode → ComCode null, không bao giờ khóa", () => {
    const refs = orderRowRefs({ ComCode: null, PaymentGatewayName: UNMAPPED, FulfilledAt: "2025-11-21" }, index);
    expect(refs).toEqual([
      { ComCode: null, Period: "202511" },
      { ComCode: null, Period: "202511" },
    ]);
    expect(firstLocked(locksOf("ZENIROXPAY|202511"), refs)).toBeUndefined();
  });

  it("chưa giao (không FulfilledAt) → kỳ null, không bị chặn", () => {
    const refs = orderRowRefs({ ComCode: "ZENIROXPAY", PaymentGatewayName: STRIPE, FulfilledAt: null }, index);
    expect(refs.map((r) => r.Period)).toEqual([null, null]);
    expect(refs.map((r) => r.ComCode)).toEqual(["ZENIROXPAY", "ZENIROXPAY"]);
    expect(firstLocked(locksOf("ZENIROXPAY|202511"), refs)).toBeUndefined();
  });
});

describe("LockTally", () => {
  const MSG_TAIL = ". Muốn ghi lại: mở khóa kỳ ở trang Kỳ kế toán (ghi lý do), chạy lại rồi khóa lại";
  const adds: [string, { ComCode: string | null; Period: string | null }, "rows" | "events", number | undefined][] = [
    ["ORDERS", { ComCode: "zeniroxpay", Period: "202511" }, "rows", 3],
    ["ORDERS", { ComCode: "ZENIROXPAY ", Period: " 202511" }, "events", 5],
    ["ORDERS", { ComCode: "ZENIROXPAY", Period: "202511" }, "rows", undefined],
    ["STRIPE", { ComCode: "ZENIROXPAY", Period: "202511" }, "events", 2],
    ["ORDERS", { ComCode: "ONTARIO", Period: "202512" }, "rows", 1],
    // Bỏ qua: thiếu ComCode / kỳ, n <= 0
    ["ORDERS", { ComCode: null, Period: "202511" }, "rows", 9],
    ["ORDERS", { ComCode: "ONTARIO", Period: "" }, "rows", 9],
    ["ORDERS", { ComCode: "ONTARIO", Period: "202601" }, "rows", 0],
  ];
  const tallyOf = (list: typeof adds) => {
    const t = new LockTally();
    for (const [ds, ref, field, n] of list) t.add(ds, ref, field, n);
    return t;
  };

  it("gom theo DataSource × ComCode × kỳ; total, periods", () => {
    const t = tallyOf(adds);
    expect(t.isEmpty).toBe(false);
    expect(t.total("rows")).toBe(5);
    expect(t.total("events")).toBe(7);
    expect(t.periods).toEqual(["ONTARIO|202512", "ZENIROXPAY|202511"]);
  });

  it("toExceptions: 1 INFO PERIOD_LOCKED mỗi nhóm, SourceKey/Message cố định, thứ tự không phụ thuộc thứ tự add", () => {
    const exceptions = tallyOf(adds).toExceptions("Build");
    expect(exceptions).toEqual([
      {
        DataSource: "ORDERS",
        ComCode: "ONTARIO",
        Period: "202512",
        Severity: "INFO",
        ExceptionType: "PERIOD_LOCKED",
        SourceKey: "PERIOD_LOCKED|ORDERS|ONTARIO|202512",
        Message: `ONTARIO kỳ 202512 đã khóa sổ → Build bỏ qua 1 dòng nguồn${MSG_TAIL}`,
      },
      {
        DataSource: "ORDERS",
        ComCode: "ZENIROXPAY",
        Period: "202511",
        Severity: "INFO",
        ExceptionType: "PERIOD_LOCKED",
        SourceKey: "PERIOD_LOCKED|ORDERS|ZENIROXPAY|202511",
        Message: `ZENIROXPAY kỳ 202511 đã khóa sổ → Build bỏ qua 4 dòng nguồn, 5 event${MSG_TAIL}`,
      },
      {
        DataSource: "STRIPE",
        ComCode: "ZENIROXPAY",
        Period: "202511",
        Severity: "INFO",
        ExceptionType: "PERIOD_LOCKED",
        SourceKey: "PERIOD_LOCKED|STRIPE|ZENIROXPAY|202511",
        Message: `ZENIROXPAY kỳ 202511 đã khóa sổ → Build bỏ qua 2 event${MSG_TAIL}`,
      },
    ]);
    expect(tallyOf([...adds].reverse()).toExceptions("Build")).toEqual(exceptions);
    expect(tallyOf(adds).toExceptions("Post")[0].Message).toContain("→ Post bỏ qua 1 dòng nguồn");
  });

  it("rỗng → không exception", () => {
    const t = tallyOf(adds.slice(5));
    expect(t.isEmpty).toBe(true);
    expect(t.total("rows")).toBe(0);
    expect(t.periods).toEqual([]);
    expect(t.toExceptions("Build")).toEqual([]);
  });
});

describe("isValidPeriod", () => {
  it.each(["202511", "202501", "202512", "190001", "209912"])("%s hợp lệ", (p) => {
    expect(isValidPeriod(p)).toBe(true);
  });

  it.each(["202513", "202500", "20251", "2025111", "2025-11", "189912", "abcdef", "", null, undefined])("%s không hợp lệ", (p) => {
    expect(isValidPeriod(p)).toBe(false);
  });
});

describe("actorError / unlockReasonError", () => {
  it("tên người thao tác: bắt buộc, tối đa actorMaxLength ký tự (đếm theo ký tự unicode, sau khi trim)", () => {
    const max = PERIOD_RULES.actorMaxLength;
    for (const blank of ["", "   ", null, undefined]) expect(actorError(blank)).toBe("Nhập tên người thao tác");
    expect(actorError("Nguyễn Văn A")).toBeNull();
    expect(actorError("a".repeat(max))).toBeNull();
    expect(actorError(`  ${"a".repeat(max)}  `)).toBeNull();
    expect(actorError("a".repeat(max + 1))).toContain(String(max));
    // Emoji = 2 đơn vị UTF-16 nhưng là 1 ký tự
    expect(actorError("😀".repeat(max))).toBeNull();
    expect(actorError("😀".repeat(max + 1))).not.toBeNull();
  });

  it("lý do mở khóa: tối thiểu unlockReasonMinLength ký tự sau khi trim, tối đa textMaxLength", () => {
    const min = PERIOD_RULES.unlockReasonMinLength;
    const max = PERIOD_RULES.textMaxLength;
    expect(min).toBe(10);
    for (const short of ["", null, undefined, "   ", "a".repeat(min - 1), `   ${"a".repeat(min - 1)}   `]) {
      expect(unlockReasonError(short)).toBe(`Lý do mở khóa tối thiểu ${min} ký tự`);
    }
    expect(unlockReasonError("a".repeat(min))).toBeNull();
    expect(unlockReasonError("Sai tỷ giá".normalize("NFC"))).toBeNull();
    expect(unlockReasonError("a".repeat(max))).toBeNull();
    expect(unlockReasonError("a".repeat(max + 1))).toBe(`Lý do mở khóa tối đa ${max} ký tự`);
    // Đếm ký tự unicode, không đếm đơn vị UTF-16: 9 emoji (18 đơn vị) vẫn là quá ngắn
    expect(unlockReasonError("😀".repeat(min - 1))).not.toBeNull();
    expect(unlockReasonError("😀".repeat(min))).toBeNull();
  });
});

describe("resolveLockTargets", () => {
  const ctx: LockContext = {
    companies: new Set(["ZENIROXPAY", "ONTARIO"]),
    periodsWithData: new Map([
      ["ZENIROXPAY", ["202509", "202510", "202511", "202512"]],
      ["ONTARIO", ["202511"]],
    ]),
    locks: locksOf("ZENIROXPAY|202510"),
  };
  /** n kỳ hợp lệ khác nhau liên tiếp từ 200001 */
  const periods = (n: number) => Array.from({ length: n }, (_, i) => `${2000 + Math.floor(i / 12)}${String((i % 12) + 1).padStart(2, "0")}`);

  it("targets tường minh: chuẩn hóa, bỏ trùng, sort, tách kỳ đã khóa", () => {
    const r = resolveLockTargets(
      {
        targets: [
          { comCode: " zeniroxpay", period: "202511" },
          { comCode: "ONTARIO", period: "202511" },
          { comCode: "ZENIROXPAY", period: " 202511 " },
          { comCode: "ZENIROXPAY", period: "202510" },
          { comCode: "zeniroxpay", period: "202509" },
          // Kỳ chưa có dữ liệu vẫn khóa được (chặn nhập nhầm)
          { comCode: "ONTARIO", period: "202601" },
        ],
      },
      ctx,
    );
    expect(r).toEqual({
      toLock: [cp("ONTARIO", "202511"), cp("ONTARIO", "202601"), cp("ZENIROXPAY", "202509"), cp("ZENIROXPAY", "202511")],
      alreadyLocked: [cp("ZENIROXPAY", "202510")],
      errors: [],
    });
  });

  it("khóa đến hết kỳ P: mọi kỳ có dữ liệu ≤ P và chính P, bỏ trùng công ty", () => {
    expect(resolveLockTargets({ comCodes: ["zeniroxpay", "ZENIROXPAY "], throughPeriod: "202511" }, ctx)).toEqual({
      toLock: [cp("ZENIROXPAY", "202509"), cp("ZENIROXPAY", "202511")],
      alreadyLocked: [cp("ZENIROXPAY", "202510")],
      errors: [],
    });
    // P chưa có dữ liệu vẫn được khóa; nhiều công ty
    expect(resolveLockTargets({ comCodes: ["ONTARIO", "zeniroxpay"], throughPeriod: " 202601 " }, ctx)).toEqual({
      toLock: [
        cp("ONTARIO", "202511"),
        cp("ONTARIO", "202601"),
        cp("ZENIROXPAY", "202509"),
        cp("ZENIROXPAY", "202511"),
        cp("ZENIROXPAY", "202512"),
        cp("ZENIROXPAY", "202601"),
      ],
      alreadyLocked: [cp("ZENIROXPAY", "202510")],
      errors: [],
    });
    // P trước mọi kỳ có dữ liệu → chỉ P
    expect(resolveLockTargets({ comCodes: ["ONTARIO"], throughPeriod: "202510" }, ctx).toLock).toEqual([cp("ONTARIO", "202510")]);
    // Kỳ có dữ liệu sai định dạng bị bỏ qua
    const dirty: LockContext = { ...ctx, periodsWithData: new Map([["ONTARIO", ["", "202513", "2025-10", "202509"]]]) };
    expect(resolveLockTargets({ comCodes: ["ONTARIO"], throughPeriod: "202511" }, dirty).toLock).toEqual([cp("ONTARIO", "202509"), cp("ONTARIO", "202511")]);
  });

  it("công ty không có trong Company → lỗi, các ô khác vẫn được tính", () => {
    const r = resolveLockTargets(
      {
        targets: [
          { comCode: "NOPE", period: "202511" },
          { comCode: "ONTARIO", period: "202511" },
        ],
      },
      ctx,
    );
    expect(r.errors).toEqual(["Công ty NOPE không có trong danh mục Company"]);
    expect(r.toLock).toEqual([cp("ONTARIO", "202511")]);
    expect(resolveLockTargets({ comCodes: ["nope"], throughPeriod: "202511" }, ctx).errors).toEqual(["Công ty NOPE không có trong danh mục Company"]);
    expect(resolveLockTargets({ targets: [{ comCode: "  ", period: "202511" }] }, ctx).errors).toEqual(["Thiếu ComCode"]);
  });

  it("kỳ sai định dạng → lỗi", () => {
    for (const period of ["202513", "202500", "20251", "189912"]) {
      const r = resolveLockTargets({ targets: [{ comCode: "ONTARIO", period }] }, ctx);
      expect(r.errors).toEqual([`Kỳ "${period}" của ONTARIO không hợp lệ (YYYYMM, tháng 01–12)`]);
      expect(r.toLock).toEqual([]);
    }
    const through = resolveLockTargets({ comCodes: ["ONTARIO"], throughPeriod: "2025-11" }, ctx);
    expect(through).toEqual({ toLock: [], alreadyLocked: [], errors: [`Kỳ "2025-11" không hợp lệ (YYYYMM, tháng 01–12)`] });
  });

  it("chọn cả 2 cách → lỗi; không chọn cách nào → lỗi; có kỳ mà thiếu công ty → lỗi", () => {
    const targets = [{ comCode: "ONTARIO", period: "202511" }];
    const both = "Chỉ chọn 1 cách: danh sách kỳ, hoặc công ty + khóa đến hết kỳ";
    for (const req of [
      { targets, comCodes: ["ONTARIO"], throughPeriod: "202511" },
      { targets, throughPeriod: "202511" },
      { targets, comCodes: ["ONTARIO"] },
    ]) {
      expect(resolveLockTargets(req, ctx)).toEqual({ toLock: [], alreadyLocked: [], errors: [both] });
    }
    for (const req of [{}, { targets: [], comCodes: [] }, { targets: null, comCodes: null, throughPeriod: "  " }]) {
      expect(resolveLockTargets(req, ctx)).toEqual({ toLock: [], alreadyLocked: [], errors: ["Chưa chọn kỳ cần khóa"] });
    }
    expect(resolveLockTargets({ throughPeriod: "202511" }, ctx).errors).toEqual(["Chọn ít nhất 1 công ty"]);
    expect(resolveLockTargets({ comCodes: ["  "], throughPeriod: "202511" }, ctx).errors).toEqual(["Chọn ít nhất 1 công ty"]);
  });

  it(`quá ${PERIOD_RULES.maxTargets} kỳ mỗi lần → lỗi (tính cả kỳ đã khóa)`, () => {
    const max = PERIOD_RULES.maxTargets;
    const tooMany = `Tối đa ${max} kỳ mỗi lần khóa`;
    const targetsOf = (list: string[]) => list.map((period) => ({ comCode: "ONTARIO", period }));
    const locked: LockContext = { ...ctx, locks: locksOf("ONTARIO|200001") };

    const ok = resolveLockTargets({ targets: targetsOf(periods(max)) }, locked);
    expect(ok.errors).toEqual([]);
    expect(ok.toLock).toHaveLength(max - 1);
    expect(ok.alreadyLocked).toEqual([cp("ONTARIO", "200001")]);

    expect(resolveLockTargets({ targets: targetsOf(periods(max + 1)) }, locked).errors).toEqual([tooMany]);
    // Trùng không tính
    expect(resolveLockTargets({ targets: targetsOf([...periods(max), "200001"]) }, ctx).errors).toEqual([]);

    const busy: LockContext = { ...ctx, periodsWithData: new Map([["ONTARIO", periods(max + 10)]]) };
    const lastData = periods(max + 10).at(-1)!;
    expect(resolveLockTargets({ comCodes: ["ONTARIO"], throughPeriod: lastData }, busy).errors).toEqual([tooMany]);
  });
});

describe("laterLockedPeriods", () => {
  it("kỳ sau của cùng công ty còn khóa", () => {
    const locks = locksOf("ZENIROXPAY|202509", "ZENIROXPAY|202511", "ZENIROXPAY|202512", "ONTARIO|202601");
    expect(laterLockedPeriods(locks, "zeniroxpay", "202510")).toEqual(["202511", "202512"]);
    expect(laterLockedPeriods(locks, "ZENIROXPAY", "202511")).toEqual(["202512"]);
    expect(laterLockedPeriods(locks, "ZENIROXPAY", "202512")).toEqual([]);
    expect(laterLockedPeriods(locks, "ONTARIO", "202512")).toEqual(["202601"]);
    expect(laterLockedPeriods(PeriodLocks.NONE, "ZENIROXPAY", "202501")).toEqual([]);
  });
});

describe("isBalanced", () => {
  it("lệch < 0,005 coi là cân", () => {
    expect(isBalanced(100, 100)).toBe(true);
    expect(isBalanced(100.004, 100)).toBe(true);
    expect(isBalanced(100, 100.004)).toBe(true);
    expect(isBalanced(0.1 + 0.2, 0.3)).toBe(true);
    expect(isBalanced(0, 0)).toBe(true);
    expect(isBalanced(100.01, 100)).toBe(false);
    expect(isBalanced(100, 100.01)).toBe(false);
    expect(isBalanced(100.005, 100)).toBe(false);
    // Số liệu thiếu (NaN từ SUM rỗng) coi là 0
    expect(isBalanced(Number.NaN, 0)).toBe(true);
  });
});

describe("pendingIssues", () => {
  const empty: PeriodCounts = { rawNotBuilt: 0, rawError: 0, eventsNew: 0, eventsError: 0, eventsPosted: 0, glLines: 0, dr: 0, cr: 0 };
  /** Kỳ đã post xong, cân */
  const clean: PeriodCounts = { ...empty, eventsPosted: 10, glLines: 20, dr: 1234.5, cr: 1234.5 };
  const codes = (c: PeriodCounts) => pendingIssues(c).map((i) => i.code);

  it("kỳ sạch → không cảnh báo; kỳ trống → NO_DATA", () => {
    expect(pendingIssues(clean)).toEqual([]);
    expect(pendingIssues(empty)).toEqual([{ code: "NO_DATA", count: 0, text: "Kỳ chưa có dữ liệu — khóa trước để chặn nhập nhầm vào kỳ này" }]);
  });

  it("kỳ chỉ có raw BUILT/SKIPPED hoặc event SKIPPED vẫn là kỳ có dữ liệu (không NO_DATA)", () => {
    expect(codes({ ...empty, rawTotal: 7 })).toEqual([]);
    expect(codes({ ...empty, eventsSkipped: 2 })).toEqual([]);
    // Raw chưa xác định công ty không làm kỳ của công ty "có dữ liệu"
    expect(codes({ ...empty, rawNoComCode: 3 })).toEqual(["RAW_NO_COMCODE", "NO_DATA"]);
  });

  it.each([
    ["RAW_NOT_BUILT", { rawNotBuilt: 3 }, 3, "3 dòng raw chưa build"],
    ["RAW_ERROR", { rawError: 2 }, 2, "2 dòng raw lỗi khi build"],
    ["RAW_NO_COMCODE", { rawNoComCode: 4 }, 4, "4 dòng raw cùng kỳ chưa xác định được công ty"],
    ["EVENTS_NEW", { eventsNew: 5 }, 5, "5 event NEW chưa Post"],
    ["EVENTS_ERROR", { eventsError: 6 }, 6, "6 event ERROR"],
    ["GL_IMBALANCED", { dr: 100, cr: 99.5 }, 1, "Sổ cái lệch: Σ Nợ 100.00 ≠ Σ Có 99.50"],
  ] as const)("%s", (code, patch, count, text) => {
    const issues = pendingIssues({ ...clean, ...patch });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code, count });
    expect(issues[0].text).toContain(text);
  });

  it("nhiều việc dở cùng lúc → đúng thứ tự; lệch dưới 0,005 không báo", () => {
    expect(codes({ ...clean, rawNotBuilt: 1, rawError: 1, rawNoComCode: 1, eventsNew: 1, eventsError: 1, dr: 10, cr: 9 })).toEqual([
      "RAW_NOT_BUILT",
      "RAW_ERROR",
      "RAW_NO_COMCODE",
      "EVENTS_NEW",
      "EVENTS_ERROR",
      "GL_IMBALANCED",
    ]);
    expect(codes({ ...clean, dr: 100.004, cr: 100 })).toEqual([]);
    // Chỉ có raw chưa build / event NEW cũng là có dữ liệu
    expect(codes({ ...empty, rawNotBuilt: 1 })).toEqual(["RAW_NOT_BUILT"]);
    expect(codes({ ...empty, eventsNew: 1 })).toEqual(["EVENTS_NEW"]);
  });
});

describe("lockMsg", () => {
  it("gợi ý Unpost chỉ khi event đã POSTED", () => {
    const ref = cp("ZENIROXPAY", "202511");
    expect(lockMsg.importRow(ref)).toContain("ZENIROXPAY kỳ 202511 đã khóa sổ");
    expect(lockMsg.importEvent(7, ref, "POSTED")).toContain("Unpost + Unbuild");
    expect(lockMsg.importEvent(7, ref, "NEW")).not.toContain("Unpost");
    const holder = { ...ref, AccountingEventID: 7, JournalTypeCode: "ORD_REV_PRODUCT_FULFILLED" };
    expect(lockMsg.blockedByLocked({ ...holder, PostStatus: "POSTED" })).toContain("Unpost + Unbuild");
    expect(lockMsg.blockedByLocked({ ...holder, PostStatus: "NEW" })).not.toContain("Unpost");
    expect(lockMsg.sameKeyLocked({ ...holder, PostStatus: "NEW" }, "202512")).toContain("nay thuộc kỳ 202512");
  });

  it("từ chối xóa dữ liệu test: liệt kê tối đa 5 kỳ", () => {
    expect(lockMsg.resetRefused(locksOf("ONTARIO|202511", "ZENIROXPAY|202511"))).toBe(
      "Còn 2 kỳ đang khóa sổ (ONTARIO kỳ 202511, ZENIROXPAY kỳ 202511) → mở khóa ở trang Kỳ kế toán trước khi xóa dữ liệu test",
    );
    const many = locksOf(...["202505", "202506", "202507", "202508", "202509", "202510", "202511"].map((p) => `ZENIROXPAY|${p}`));
    const msg = lockMsg.resetRefused(many);
    expect(msg).toMatch(/^Còn 7 kỳ đang khóa sổ \(ZENIROXPAY kỳ 202505, .*ZENIROXPAY kỳ 202509 và 2 kỳ khác\)/);
    expect(msg).not.toContain("202510");
  });
});
