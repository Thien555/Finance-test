"use client";

import { HistoryOutlined, LockOutlined, ReloadOutlined, UnlockOutlined, WarningOutlined } from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Popover,
  Select,
  Space,
  Table,
  type TableColumnsType,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import Link from "next/link";
import { useMemo, useState } from "react";
import { money, postJson, toQuery, useApi } from "@/components/client";
import { columnsOf, FieldTitle, StatusTag } from "@/components/ui";
import type { AccountingPeriodLogRow } from "@/lib/db/schema";
import type { PendingIssue } from "@/lib/engine/period-lock";
import { PERIOD_FIELD_DOCS, PERIOD_LOG_FIELD_DOCS, PERIOD_RULES } from "@/lib/field-docs";
import type {
  LockPreview,
  LockResult,
  PendingCheck,
  PeriodCell,
  PeriodCompany,
  PeriodGrid,
  UnassignedRaw,
  UnlockPreview,
  UnlockResult,
} from "@/lib/services/periods";

const { Title, Text } = Typography;

/** Tên người thao tác nhớ trên trình duyệt (chưa có đăng nhập) */
const ACTOR_KEY = "sky-finance.periodActor";

function readActor(): string {
  try {
    return window.localStorage.getItem(ACTOR_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeActor(name: string) {
  try {
    window.localStorage.setItem(ACTOR_KEY, name.trim());
  } catch {
    // Trình duyệt chặn localStorage → lần sau gõ lại tên
  }
}

/** Khóa ô "COMCODE|YYYYMM" (cùng dạng lockKey của server) */
const cellKey = (comCode: string, period: string) => `${comCode}|${period}`;
const splitKey = (key: string) => {
  const i = key.lastIndexOf("|");
  return { comCode: key.slice(0, i), period: key.slice(i + 1) };
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Việc dở thật sự (NO_DATA chỉ là thông tin: kỳ trống vẫn nên khóa trước) */
const pendingOf = (issues: PendingIssue[]) => issues.filter((i) => i.code !== "NO_DATA");
const hasData = (c: PeriodCell) =>
  c.glLines > 0 || Object.values(c.events).some((n) => n > 0) || Object.values(c.rawBySource).some((r) => r.total > 0);

const chip = { marginInlineEnd: 0, fontSize: 11, lineHeight: "18px", paddingInline: 5 };

interface ThroughInit {
  comCodes: string[];
  through: Dayjs;
}

type LockTargetBody = { targets: { comCode: string; period: string }[] } | { comCodes: string[]; throughPeriod: string };

export default function PeriodsPage() {
  const { message } = App.useApp();
  const [range, setRange] = useState<{ periodFrom?: string; periodTo?: string }>({});
  const [shownComCodes, setShownComCodes] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [actor, setActor] = useState("");
  const [lockPreview, setLockPreview] = useState<LockPreview | null>(null);
  const [unlockPreview, setUnlockPreview] = useState<UnlockPreview | null>(null);
  const [throughInit, setThroughInit] = useState<ThroughInit | null>(null);
  const [history, setHistory] = useState<{ comCode?: string; period?: string } | null>(null);

  const grid = useApi<PeriodGrid>(`/api/periods${toQuery(range)}`);
  const data = grid.data;
  const cellMap = useMemo(() => new Map((data?.cells ?? []).map((c) => [cellKey(c.ComCode, c.Period), c])), [data]);
  const periods = useMemo(() => data?.periods ?? [], [data]);
  const companies = useMemo(
    () => (data?.companies ?? []).filter((c) => shownComCodes.length === 0 || shownComCodes.includes(c.ComCode)),
    [data, shownComCodes],
  );

  // Chỉ tính các ô đang hiện: ẩn công ty / đổi kỳ thì ô đã chọn trước đó không bị khóa nhầm
  const active = useMemo(() => {
    const coms = new Set(companies.filter((c) => c.InCompanyTable).map((c) => c.ComCode));
    const ps = new Set(periods);
    return selected.filter((k) => {
      const { comCode, period } = splitKey(k);
      return coms.has(comCode) && ps.has(period);
    });
  }, [selected, companies, periods]);
  const selectedSet = new Set(active);
  const statusOf = (key: string) => cellMap.get(key)?.Status ?? "OPEN";
  const toLock = active.filter((k) => statusOf(k) === "OPEN");
  const unlockKey = active.length === 1 && statusOf(active[0]) === "LOCKED" ? active[0] : null;

  const toggle = (keys: string[], on: boolean) =>
    setSelected((prev) => {
      const s = new Set(prev);
      for (const k of keys) {
        if (on) s.add(k);
        else s.delete(k);
      }
      return [...s];
    });

  const afterChange = async () => {
    setSelected([]);
    await grid.reload();
  };

  /** Xem trước khóa → mở hộp xác nhận. Trả false nếu không còn gì để khóa */
  const previewLock = async (body: LockTargetBody): Promise<boolean> => {
    const r = await postJson<LockPreview>("/api/periods/lock", { ...body, preview: true });
    if (r.targets.length === 0) {
      message.info(`Không còn kỳ nào cần khóa${r.alreadyLocked.length ? ` (${r.alreadyLocked.length} kỳ đã khóa sẵn)` : ""}`);
      return false;
    }
    setActor(readActor());
    setLockPreview(r);
    return true;
  };

  const lockSelected = async () => {
    setBusy("lock");
    try {
      await previewLock({ targets: toLock.map(splitKey) });
    } catch (e) {
      message.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const openUnlock = async () => {
    if (!unlockKey) return;
    setBusy("unlock");
    try {
      const r = await postJson<UnlockPreview>("/api/periods/unlock", { ...splitKey(unlockKey), preview: true });
      setActor(readActor());
      setUnlockPreview(r);
    } catch (e) {
      message.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const openThrough = () => {
    const coms = companies.filter((c) => c.InCompanyTable).map((c) => c.ComCode);
    setThroughInit({ comCodes: shownComCodes.length ? coms : [], through: dayjs().subtract(1, "month") });
  };

  const openHistory = () => setHistory(active.length === 1 ? splitKey(active[0]) : {});

  const columns: TableColumnsType<{ Period: string }> = [
    {
      key: "Period",
      title: "Kỳ",
      dataIndex: "Period",
      fixed: "left",
      width: 120,
      render: (p: string) => {
        const keys = companies.filter((c) => c.InCompanyTable).map((c) => cellKey(c.ComCode, p));
        const n = keys.filter((k) => selectedSet.has(k)).length;
        return (
          <Space size={6}>
            <Tooltip title="Chọn cả kỳ (mọi công ty đang hiện)">
              <Checkbox
                checked={n > 0 && n === keys.length}
                indeterminate={n > 0 && n < keys.length}
                disabled={!keys.length}
                onChange={(e) => toggle(keys, e.target.checked)}
              />
            </Tooltip>
            <Text strong>{p}</Text>
          </Space>
        );
      },
    },
    ...companies.map((c) => ({
      key: c.ComCode,
      title: <CompanyTitle company={c} />,
      width: 210,
      onCell: (r: { Period: string }) => {
        const key = cellKey(c.ComCode, r.Period);
        const background = selectedSet.has(key) ? "#e6f4ff" : statusOf(key) === "LOCKED" ? "#fff7f5" : undefined;
        return { style: { background, verticalAlign: "top" as const } };
      },
      render: (_: unknown, r: { Period: string }) => {
        const key = cellKey(c.ComCode, r.Period);
        return <MatrixCell company={c} cell={cellMap.get(key)} checked={selectedSet.has(key)} onToggle={(on) => toggle([key], on)} />;
      },
    })),
  ];

  return (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <div>
        <Title level={3} style={{ marginBottom: 4 }}>
          Kỳ kế toán (khóa sổ)
        </Title>
        <Text type="secondary">
          Khóa sổ theo công ty × tháng để số liệu đã chốt / đã báo cáo không bị đổi âm thầm. Kỳ chưa từng khóa là OPEN.
        </Text>
      </div>

      <Alert
        type="info"
        showIcon
        title="Kỳ LOCKED: Import từ chối dòng thuộc kỳ; Build, Post, Unpost, Unbuild bỏ qua dữ liệu của kỳ và báo số lượng; không được “Xóa dữ liệu test” khi còn kỳ khóa."
        description={`Khóa khi còn việc dở chỉ cảnh báo (nội dung lưu vào lịch sử). Mở khóa cần tên + lý do tối thiểu ${PERIOD_RULES.unlockReasonMinLength} ký tự; mọi lần khóa / mở khóa đều ghi Lịch sử.`}
      />

      <Card>
        <Space wrap>
          <Select
            mode="multiple"
            allowClear
            placeholder="Công ty (tất cả)"
            style={{ minWidth: 280 }}
            maxTagCount="responsive"
            value={shownComCodes}
            onChange={setShownComCodes}
            options={(data?.companies ?? []).map((c) => ({ value: c.ComCode, label: `${c.ComCode}${c.CompanyName ? ` – ${c.CompanyName}` : ""}` }))}
          />
          <DatePicker.RangePicker
            picker="month"
            allowEmpty={[true, true]}
            placeholder={["Kỳ từ", "Kỳ đến"]}
            format="YYYYMM"
            value={[range.periodFrom ? dayjs(range.periodFrom, "YYYYMM") : null, range.periodTo ? dayjs(range.periodTo, "YYYYMM") : null]}
            onChange={(r) => {
              setRange({ periodFrom: r?.[0]?.format("YYYYMM") ?? undefined, periodTo: r?.[1]?.format("YYYYMM") ?? undefined });
              setSelected([]);
            }}
          />
          <Button icon={<ReloadOutlined />} loading={grid.loading} onClick={grid.reload}>
            Tải lại
          </Button>
          <Text type="secondary">
            Đang khóa <b>{data?.lockedCount ?? 0}</b> kỳ (mọi công ty)
          </Text>
        </Space>
      </Card>

      {grid.error && <Alert type="error" showIcon title={grid.error} />}
      <UnassignedAlert rows={data?.unassigned ?? []} />

      <Card>
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          <Space wrap>
            <Button type="primary" icon={<LockOutlined />} disabled={!toLock.length} loading={busy === "lock"} onClick={lockSelected}>
              Khóa ({toLock.length})
            </Button>
            <Button icon={<LockOutlined />} onClick={openThrough}>
              Khóa đến hết kỳ…
            </Button>
            <Tooltip title={unlockKey ? undefined : "Chọn đúng 1 ô đang LOCKED"}>
              <Button danger icon={<UnlockOutlined />} disabled={!unlockKey} loading={busy === "unlock"} onClick={openUnlock}>
                Mở khóa
              </Button>
            </Tooltip>
            <Button icon={<HistoryOutlined />} onClick={openHistory}>
              Lịch sử
            </Button>
            {active.length > 0 && (
              <Button type="link" onClick={() => setSelected([])}>
                Bỏ chọn ({active.length})
              </Button>
            )}
          </Space>
          <Table<{ Period: string }>
            size="small"
            bordered
            rowKey="Period"
            loading={grid.loading}
            dataSource={periods.map((Period) => ({ Period }))}
            columns={columns}
            scroll={{ x: "max-content" }}
            pagination={{ pageSize: 24, hideOnSinglePage: true, showTotal: (t) => `${t} kỳ` }}
            locale={{ emptyText: "Chưa có dữ liệu. Chọn khoảng “Kỳ từ – Kỳ đến” để hiện đủ các tháng (khóa trước cả tháng chưa có dữ liệu)." }}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            Ô: trạng thái kỳ · GL số dòng · số chứng từ (CT). Chip: <Tag color="blue" style={chip}>NEW</Tag> event chưa Post,{" "}
            <Tag color="red" style={chip}>ERR</Tag> event lỗi, <Tag color="orange" style={chip}>Raw</Tag> dòng raw chưa build / lỗi,{" "}
            <Tag color="red" style={chip}>Lệch</Tag> Σ Nợ ≠ Σ Có. Rê chuột vào ô để xem chi tiết.
          </Text>
        </Space>
      </Card>

      <LockModal preview={lockPreview} actor={actor} onClose={() => setLockPreview(null)} onDone={afterChange} />
      <UnlockModal preview={unlockPreview} actor={actor} onClose={() => setUnlockPreview(null)} onDone={afterChange} />
      <ThroughModal
        init={throughInit}
        companies={data?.companies ?? []}
        onClose={() => setThroughInit(null)}
        onPreview={(comCodes, throughPeriod) => previewLock({ comCodes, throughPeriod })}
      />
      <Drawer title="Lịch sử khóa / mở khóa kỳ" size={1100} open={!!history} onClose={() => setHistory(null)} destroyOnHidden>
        {history && <HistoryPanel initial={history} />}
      </Drawer>
    </Space>
  );
}

// ───────────────────────────── Ma trận ─────────────────────────────

function CompanyTitle({ company }: { company: PeriodCompany }) {
  const label = `${company.ComCode} (${company.FunctionalCurrency ?? "?"})`;
  if (!company.InCompanyTable) {
    return (
      <Tooltip title="ComCode có trong dữ liệu nhưng không có trong bảng Company → không khóa được. Thêm công ty ở Master data.">
        <Text type="warning">
          {label} <WarningOutlined />
        </Text>
      </Tooltip>
    );
  }
  return <Tooltip title={company.CompanyName}>{label}</Tooltip>;
}

function MatrixCell({
  company,
  cell,
  checked,
  onToggle,
}: {
  company: PeriodCompany;
  cell: PeriodCell | undefined;
  checked: boolean;
  onToggle: (on: boolean) => void;
}) {
  const box = <Checkbox checked={checked} disabled={!company.InCompanyTable} onChange={(e) => onToggle(e.target.checked)} />;
  if (!cell) {
    return (
      <Space size={6}>
        {box}
        <Text type="secondary">—</Text>
      </Space>
    );
  }
  const raw = cell.rawNotBuilt + cell.rawError;
  const withData = hasData(cell);
  return (
    <Space orientation="vertical" size={2}>
      <Space size={6}>
        {box}
        <StatusTag value={cell.Status} />
      </Space>
      <Popover title={`${cell.ComCode} kỳ ${cell.Period}`} content={<CellDetail cell={cell} />} placement="right" mouseEnterDelay={0.3}>
        <div style={{ cursor: "help" }}>
          {withData ? (
            <Text style={{ fontSize: 12 }}>
              GL {cell.glLines} dòng · {cell.glDocs} CT
            </Text>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              — chưa có dữ liệu
            </Text>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 2 }}>
            {cell.events.NEW > 0 && (
              <Tag color="blue" style={chip}>
                NEW {cell.events.NEW}
              </Tag>
            )}
            {cell.events.ERROR > 0 && (
              <Tag color="red" style={chip}>
                ERR {cell.events.ERROR}
              </Tag>
            )}
            {raw > 0 && (
              <Tag color="orange" style={chip}>
                Raw {raw}
              </Tag>
            )}
            {!cell.balanced && (
              <Tag color="red" style={chip}>
                Lệch
              </Tag>
            )}
          </div>
        </div>
      </Popover>
    </Space>
  );
}

function CellDetail({ cell }: { cell: PeriodCell }) {
  const e = cell.events;
  const pending = pendingOf(cell.issues);
  return (
    <Space orientation="vertical" size={8} style={{ width: 420 }}>
      <Descriptions
        size="small"
        column={1}
        bordered
        items={[
          ...Object.entries(cell.rawBySource).map(([ds, r]) => ({
            key: ds,
            label: `Raw ${ds}`,
            children: r.total ? `${r.total} dòng · chưa build ${r.notBuilt} · lỗi ${r.error}` : "—",
          })),
          { key: "events", label: "Event", children: `NEW ${e.NEW} · ERROR ${e.ERROR} · POSTED ${e.POSTED} · SKIPPED ${e.SKIPPED}` },
          { key: "gl", label: "GLTrans", children: `${cell.glLines} dòng · ${cell.glDocs} chứng từ` },
          { key: "dr", label: "Σ Nợ", children: <span className="num">{money(cell.dr)}</span> },
          { key: "cr", label: "Σ Có", children: <span className="num">{money(cell.cr)}</span> },
          { key: "bal", label: "Nợ / Có", children: <BalanceTag balanced={cell.balanced} /> },
          ...(cell.LockedAt
            ? [{ key: "locked", label: "Khóa gần nhất", children: `${cell.LockedBy ?? ""} lúc ${cell.LockedAt}${cell.Note ? ` — ${cell.Note}` : ""}` }]
            : []),
          ...(cell.UnlockedAt
            ? [{ key: "unlocked", label: "Mở khóa gần nhất", children: `${cell.UnlockedBy ?? ""} lúc ${cell.UnlockedAt} — ${cell.UnlockReason ?? ""}` }]
            : []),
        ]}
      />
      {pending.length > 0 && <IssueList issues={pending} />}
    </Space>
  );
}

const BalanceTag = ({ balanced }: { balanced: boolean }) => (balanced ? <Tag color="green">Cân</Tag> : <Tag color="red">Lệch</Tag>);

function IssueList({ issues }: { issues: PendingIssue[] }) {
  return (
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {issues.map((i) => (
        <li key={i.code}>{i.text}</li>
      ))}
    </ul>
  );
}

function UnassignedAlert({ rows }: { rows: UnassignedRaw[] }) {
  if (!rows.length) return null;
  const byPeriod = new Map<string, UnassignedRaw[]>();
  for (const r of rows) byPeriod.set(r.Period, [...(byPeriod.get(r.Period) ?? []), r]);
  return (
    <Alert
      type="warning"
      showIcon
      title="Có dòng raw chưa xác định công ty (ComCode trống) — không khóa theo công ty được"
      description={
        <Space orientation="vertical" size={2}>
          {[...byPeriod].map(([p, list]) => (
            <span key={p}>
              <b>{p}</b>: {list.map((u) => `${u.DataSource} ${u.NotBuilt} chưa build · ${u.Error} lỗi`).join("; ")}
            </span>
          ))}
          <span>
            Orders: thêm GatewayCompanyMapping ở <Link href="/master">Master data</Link> rồi Build lại. PayPal / Stripe / PIPO: điền cột ComCode trên file rồi
            import lại.
          </span>
        </Space>
      }
    />
  );
}

// ───────────────────────────── Khóa ─────────────────────────────

const CHECK_COLUMNS: TableColumnsType<PendingCheck> = [
  { key: "ComCode", title: "ComCode", dataIndex: "ComCode", width: 130 },
  { key: "Period", title: "Kỳ", dataIndex: "Period", width: 80 },
  { key: "rawNotBuilt", title: "Raw chưa build", dataIndex: "rawNotBuilt", align: "right", width: 90 },
  { key: "rawError", title: "Raw lỗi", dataIndex: "rawError", align: "right", width: 70 },
  { key: "new", title: "Event NEW", align: "right", width: 80, render: (_, t) => t.events.NEW },
  { key: "error", title: "Event ERROR", align: "right", width: 90, render: (_, t) => t.events.ERROR },
  { key: "glLines", title: "Dòng GL", dataIndex: "glLines", align: "right", width: 80 },
  { key: "dr", title: "Σ Nợ", dataIndex: "dr", align: "right", width: 130, render: (v: number) => <span className="num">{money(v)}</span> },
  { key: "cr", title: "Σ Có", dataIndex: "cr", align: "right", width: 130, render: (v: number) => <span className="num">{money(v)}</span> },
  { key: "balanced", title: "Nợ/Có", dataIndex: "balanced", width: 70, render: (v: boolean) => <BalanceTag balanced={v} /> },
  {
    key: "issues",
    title: "Việc dở",
    width: 380,
    render: (_, t) => {
      const pending = pendingOf(t.issues);
      if (pending.length) return <IssueList issues={pending} />;
      const info = t.issues.find((i) => i.code === "NO_DATA");
      return <Text type="secondary">{info ? info.text : "—"}</Text>;
    },
  },
];

function LockModal({
  preview,
  actor,
  onClose,
  onDone,
}: {
  preview: LockPreview | null;
  actor: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ actor: string; note?: string; ack?: boolean }>();
  const [saving, setSaving] = useState(false);
  const targets = preview?.targets ?? [];
  const withIssues = targets.filter((t) => pendingOf(t.issues).length > 0);

  const submit = async () => {
    const v = await form.validateFields().catch(() => null);
    if (!v || !preview) return;
    setSaving(true);
    try {
      // Gửi đúng danh sách đã xem trước ("khóa đến hết kỳ" không nở thêm kỳ khác lúc xác nhận)
      const r = await postJson<LockResult>("/api/periods/lock", {
        targets: targets.map((t) => ({ comCode: t.ComCode, period: t.Period })),
        actor: v.actor,
        note: v.note,
      });
      writeActor(v.actor);
      message.success(`Đã khóa ${r.locked.length} kỳ${r.alreadyLocked.length ? ` (${r.alreadyLocked.length} kỳ đã khóa sẵn – bỏ qua)` : ""}`);
      onClose();
      await onDone();
    } catch (e) {
      message.error(errText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!preview}
      title={`Khóa sổ ${targets.length} kỳ`}
      width={1100}
      okText="Khóa sổ"
      okButtonProps={{ icon: <LockOutlined /> }}
      confirmLoading={saving}
      onOk={submit}
      onCancel={onClose}
      destroyOnHidden
    >
      <Space orientation="vertical" size={12} style={{ width: "100%" }}>
        {withIssues.length > 0 ? (
          <Alert
            type="warning"
            showIcon
            title={`Còn việc dở ở ${withIssues.length} kỳ`}
            description="Vẫn khóa được. Sau khi khóa, Build / Post / Unpost / Unbuild bỏ qua dữ liệu của kỳ và Import từ chối dòng thuộc kỳ cho tới khi mở khóa. Nội dung cảnh báo được lưu vào lịch sử."
          />
        ) : (
          <Alert type="success" showIcon title="Không còn việc dở: raw đã build, event đã post hết, sổ cân Nợ / Có" />
        )}
        <Table<PendingCheck>
          size="small"
          rowKey={(t) => cellKey(t.ComCode, t.Period)}
          dataSource={targets}
          columns={CHECK_COLUMNS}
          scroll={{ x: "max-content" }}
          pagination={{ pageSize: 8, hideOnSinglePage: true }}
        />
        {!!preview?.alreadyLocked.length && (
          <Alert type="info" showIcon title={`Đã khóa – bỏ qua: ${preview.alreadyLocked.map((t) => `${t.ComCode} ${t.Period}`).join(", ")}`} />
        )}
        <Form form={form} layout="vertical" preserve={false} initialValues={{ actor }}>
          <Form.Item
            name="actor"
            label="Người khóa"
            rules={[
              { required: true, whitespace: true, message: "Nhập tên người khóa" },
              { max: PERIOD_RULES.actorMaxLength, message: `Tối đa ${PERIOD_RULES.actorMaxLength} ký tự` },
            ]}
          >
            <Input maxLength={PERIOD_RULES.actorMaxLength} placeholder="Tên kế toán (được nhớ trên trình duyệt này)" />
          </Form.Item>
          <Form.Item name="note" label="Ghi chú (không bắt buộc)">
            <Input.TextArea rows={2} maxLength={PERIOD_RULES.textMaxLength} showCount placeholder="VD: Chốt số liệu báo cáo tháng 11" />
          </Form.Item>
          {withIssues.length > 0 && (
            <Form.Item
              name="ack"
              valuePropName="checked"
              rules={[{ validator: (_, v) => (v ? Promise.resolve() : Promise.reject(new Error("Đánh dấu đã xem cảnh báo trước khi khóa"))) }]}
            >
              <Checkbox>Tôi đã xem cảnh báo việc dở ở trên và vẫn muốn khóa</Checkbox>
            </Form.Item>
          )}
        </Form>
      </Space>
    </Modal>
  );
}

function ThroughModal({
  init,
  companies,
  onClose,
  onPreview,
}: {
  init: ThroughInit | null;
  companies: PeriodCompany[];
  onClose: () => void;
  onPreview: (comCodes: string[], throughPeriod: string) => Promise<boolean>;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<ThroughInit>();
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    setLoading(true);
    try {
      if (await onPreview(v.comCodes, v.through.format("YYYYMM"))) onClose();
    } catch (e) {
      message.error(errText(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal open={!!init} title="Khóa mọi kỳ đến hết kỳ…" okText="Xem trước" confirmLoading={loading} onOk={submit} onCancel={onClose} destroyOnHidden>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        title="Khóa mọi kỳ ≤ kỳ chọn có dữ liệu (và chính kỳ đó) của các công ty; kỳ đã khóa bỏ qua. Bước sau xem trước việc dở rồi mới xác nhận."
      />
      <Form form={form} layout="vertical" preserve={false} initialValues={init ?? undefined}>
        <Form.Item name="comCodes" label="Công ty" rules={[{ required: true, type: "array", min: 1, message: "Chọn ít nhất 1 công ty" }]}>
          <Select
            mode="multiple"
            allowClear
            placeholder="Chọn công ty"
            options={companies
              .filter((c) => c.InCompanyTable)
              .map((c) => ({ value: c.ComCode, label: `${c.ComCode}${c.CompanyName ? ` – ${c.CompanyName}` : ""}` }))}
          />
        </Form.Item>
        <Form.Item name="through" label="Khóa đến hết kỳ" rules={[{ required: true, message: "Chọn kỳ" }]}>
          <DatePicker picker="month" format="YYYYMM" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ───────────────────────────── Mở khóa ─────────────────────────────

function UnlockModal({
  preview,
  actor,
  onClose,
  onDone,
}: {
  preview: UnlockPreview | null;
  actor: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ actor: string; reason: string }>();
  const [saving, setSaving] = useState(false);
  const min = PERIOD_RULES.unlockReasonMinLength;

  const submit = async () => {
    const v = await form.validateFields().catch(() => null);
    if (!v || !preview) return;
    setSaving(true);
    try {
      const r = await postJson<UnlockResult>("/api/periods/unlock", { comCode: preview.ComCode, period: preview.Period, actor: v.actor, reason: v.reason });
      writeActor(v.actor);
      message.success(`Đã mở khóa ${r.ComCode} kỳ ${r.Period}. Sửa xong nhớ khóa lại.`);
      onClose();
      await onDone();
    } catch (e) {
      message.error(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const row = preview?.row;
  const check = preview?.check;
  const pending = check ? pendingOf(check.issues) : [];
  return (
    <Modal
      open={!!preview}
      title={preview ? `Mở khóa ${preview.ComCode} kỳ ${preview.Period}` : "Mở khóa"}
      width={720}
      okText="Mở khóa"
      okButtonProps={{ danger: true, icon: <UnlockOutlined /> }}
      confirmLoading={saving}
      onOk={submit}
      onCancel={onClose}
      destroyOnHidden
    >
      {preview && check && (
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            title="Mở khóa cho phép Import / Build / Post / Unpost / Unbuild lại dữ liệu của kỳ này."
            description="Sửa xong nhớ khóa lại. Tên người mở và lý do được lưu vào lịch sử."
          />
          {preview.laterLockedPeriods.length > 0 && (
            <Alert
              type="warning"
              showIcon
              title={`Các kỳ sau của ${preview.ComCode} vẫn đang khóa: ${preview.laterLockedPeriods.join(", ")}`}
              description="Sửa số liệu kỳ này có thể làm số đã chốt của các kỳ sau không còn khớp. Vẫn mở khóa được."
            />
          )}
          <Descriptions
            size="small"
            column={2}
            bordered
            items={[
              { key: "LockedBy", label: <FieldTitle name="LockedBy" docs={PERIOD_FIELD_DOCS} />, children: row?.LockedBy },
              { key: "LockedAt", label: <FieldTitle name="LockedAt" docs={PERIOD_FIELD_DOCS} />, children: row?.LockedAt },
              { key: "Note", label: <FieldTitle name="Note" docs={PERIOD_FIELD_DOCS} />, children: row?.Note, span: 2 },
              { key: "gl", label: "GLTrans", children: `${check.glLines} dòng · ${check.glDocs} chứng từ` },
              { key: "bal", label: "Nợ / Có", children: <BalanceTag balanced={check.balanced} /> },
              { key: "dr", label: "Σ Nợ", children: <span className="num">{money(check.dr)}</span> },
              { key: "cr", label: "Σ Có", children: <span className="num">{money(check.cr)}</span> },
            ]}
          />
          {pending.length > 0 && <IssueList issues={pending} />}
          <Form form={form} layout="vertical" preserve={false} initialValues={{ actor }}>
            <Form.Item
              name="actor"
              label="Người mở khóa"
              rules={[
                { required: true, whitespace: true, message: "Nhập tên người mở khóa" },
                { max: PERIOD_RULES.actorMaxLength, message: `Tối đa ${PERIOD_RULES.actorMaxLength} ký tự` },
              ]}
            >
              <Input maxLength={PERIOD_RULES.actorMaxLength} placeholder="Tên kế toán (được nhớ trên trình duyệt này)" />
            </Form.Item>
            <Form.Item
              name="reason"
              label="Lý do mở khóa"
              rules={[
                {
                  validator: (_, v: string | undefined) =>
                    [...(v ?? "").trim()].length >= min ? Promise.resolve() : Promise.reject(new Error(`Nhập lý do tối thiểu ${min} ký tự`)),
                },
              ]}
            >
              <Input.TextArea rows={3} maxLength={PERIOD_RULES.textMaxLength} showCount placeholder="VD: Sao kê PayPal T11 về muộn, cần import bổ sung" />
            </Form.Item>
          </Form>
        </Space>
      )}
    </Modal>
  );
}

// ───────────────────────────── Lịch sử ─────────────────────────────

const LOG_FIELDS = ["ID", "CreatedAt", "ComCode", "Period", "Action", "FromStatus", "ToStatus", "ActorName", "Reason", "ChecksSnapshot"];

function prettyJson(json: string | null): string {
  if (!json) return "";
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

/** Tóm tắt ChecksSnapshot: số việc dở + GL; chi tiết JSON ở dòng mở rộng */
function SnapshotSummary({ json }: { json: string | null }) {
  if (!json) return null;
  let snap: Partial<PendingCheck>;
  try {
    snap = JSON.parse(json) as Partial<PendingCheck>;
  } catch {
    return <Text type="secondary">{json.slice(0, 80)}</Text>;
  }
  const pending = pendingOf(snap.issues ?? []);
  return (
    <Space size={6}>
      {pending.length ? (
        <Tooltip title={<IssueList issues={pending} />}>
          <Tag color="orange">{pending.length} việc dở</Tag>
        </Tooltip>
      ) : (
        <Tag color="green">Không việc dở</Tag>
      )}
      <Text type="secondary" style={{ fontSize: 12 }}>
        GL {snap.glLines ?? 0} dòng · Σ Nợ {money(snap.dr ?? 0)}
      </Text>
    </Space>
  );
}

function HistoryPanel({ initial }: { initial: { comCode?: string; period?: string } }) {
  const [filter, setFilter] = useState<{ comCode?: string; period?: string; action?: string }>(initial);
  const [page, setPage] = useState({ page: 1, pageSize: 20 });
  const log = useApi<{ rows: AccountingPeriodLogRow[]; total: number }>(`/api/periods/log${toQuery({ ...filter, ...page })}`);
  const columns = useMemo(
    () =>
      columnsOf<AccountingPeriodLogRow>(LOG_FIELDS, PERIOD_LOG_FIELD_DOCS, {
        Reason: { width: 260, ellipsis: true },
        ChecksSnapshot: { width: 300, render: (v: string | null) => <SnapshotSummary json={v} /> },
      }),
    [],
  );

  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <Space wrap>
        {filter.comCode && (
          <Tag
            closable
            onClose={() => {
              setFilter({ action: filter.action });
              setPage({ ...page, page: 1 });
            }}
          >
            {filter.comCode} kỳ {filter.period}
          </Tag>
        )}
        <Select
          allowClear
          placeholder="Thao tác (tất cả)"
          style={{ width: 200 }}
          value={filter.action}
          onChange={(action) => {
            setFilter({ ...filter, action });
            setPage({ ...page, page: 1 });
          }}
          options={[
            { value: "LOCK", label: "LOCK – khóa" },
            { value: "UNLOCK", label: "UNLOCK – mở khóa" },
          ]}
        />
        <Button icon={<ReloadOutlined />} onClick={log.reload} />
      </Space>
      {log.error && <Alert type="error" showIcon title={log.error} />}
      <Table<AccountingPeriodLogRow>
        size="small"
        rowKey="ID"
        loading={log.loading}
        dataSource={log.data?.rows}
        columns={columns}
        scroll={{ x: "max-content" }}
        expandable={{
          rowExpandable: (r) => !!r.ChecksSnapshot,
          expandedRowRender: (r) => <pre style={{ margin: 0, fontSize: 12, maxHeight: 360, overflow: "auto" }}>{prettyJson(r.ChecksSnapshot)}</pre>,
        }}
        pagination={{
          current: page.page,
          pageSize: page.pageSize,
          total: log.data?.total,
          showSizeChanger: true,
          showTotal: (t) => `${t} dòng`,
          onChange: (p, s) => setPage({ page: p, pageSize: s }),
        }}
      />
    </Space>
  );
}
