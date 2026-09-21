"use client";

import { BuildOutlined, DownloadOutlined, ReloadOutlined, RollbackOutlined } from "@ant-design/icons";
import { Alert, App, Button, Card, Descriptions, Drawer, Input, Select, Space, Table, Typography } from "antd";
import { useMemo, useState } from "react";
import { money, postJson, toQuery, useApi, useOptions } from "@/components/client";
import { columnsOf, type ScopeValue, ScopeBar, StatusTag } from "@/components/ui";
import type { AccountingEventRow, GLTransRow, JournalLineRuleRow, JournalTypeRow, RawOrderRow } from "@/lib/db/schema";
import { EVENT_FIELD_DOCS, GL_FIELD_DOCS } from "@/lib/field-docs";
import type { BuildSummary } from "@/lib/services/build";
import type { UnbuildResult } from "@/lib/services/clear";

const EVENT_FIELDS = Object.keys(EVENT_FIELD_DOCS);

interface EventList {
  rows: AccountingEventRow[];
  total: number;
  summary: { JournalTypeCode: string; PostStatus: string; Events: number; Amount: number }[];
}

interface EventDetail {
  event: AccountingEventRow;
  orders: RawOrderRow[];
  rule: JournalLineRuleRow | null;
  journalType: JournalTypeRow | null;
  glLines: GLTransRow[];
}

export default function EventsPage() {
  const { message, modal } = App.useApp();
  const { data: options } = useOptions();
  const [scope, setScope] = useState<ScopeValue>({});
  const [filter, setFilter] = useState<{ journalTypeCode?: string; postStatus?: string; search?: string }>({});
  const [page, setPage] = useState({ page: 1, pageSize: 10 });
  const [busy, setBusy] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);

  const query = toQuery({ ...scope, ...filter });
  const list = useApi<EventList>(`/api/events${toQuery({ ...scope, ...filter, ...page })}`);
  const detail = useApi<EventDetail>(detailId ? `/api/events/${detailId}` : null);
  const columns = useMemo(
    () =>
      columnsOf<AccountingEventRow>(EVENT_FIELDS, EVENT_FIELD_DOCS, {
        AccountingEventID: { fixed: "left", width: 110 },
        TransactionID: { fixed: "left" },
      }),
    [],
  );

  const build = async () => {
    setBusy("build");
    try {
      const r = await postJson<BuildSummary>("/api/build", scope);
      if (r.Status === "FAILED") throw new Error(r.ErrorMessage);
      modal.success({
        title: `Build xong (BuildBatchID ${r.BuildBatchID})`,
        width: 560,
        content: (
          <Descriptions
            size="small"
            column={1}
            bordered
            items={[
              { label: "Phạm vi", children: r.scope },
              { label: "Dòng raw đọc", children: r.SourceRows },
              { label: "Dòng đủ điều kiện build", children: r.FulfilledRows },
              { label: "Dòng bị bỏ qua (chưa fulfill / bị lọc)", children: r.SkippedRows },
              { label: "Dòng lỗi mapping", children: r.ErrorRows },
              { label: "Event tạo mới", children: r.EventsCreated },
              { label: "Event thay thế (chưa post)", children: r.EventsReplaced },
              { label: "Event đã POSTED giữ nguyên", children: r.EventsUnchangedPosted },
              { label: "Event cũ bị xóa (không còn sinh ra, chưa post)", children: r.EventsRemoved },
              { label: "Event bị chặn (đã POSTED dưới khóa khác)", children: r.EventsBlocked },
              { label: "Event ERROR", children: r.EventsError },
              { label: "Bỏ qua do amount = 0", children: r.ZeroAmountSkipped },
              { label: "Exception ghi nhận", children: r.Exceptions },
            ]}
          />
        ),
      });
      await list.reload();
    } catch (e) {
      modal.error({ title: "Build lỗi", content: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const unbuildFlow = async (includePosted: boolean) => {
    setBusy(includePosted ? "unpostUnbuild" : "unbuild");
    try {
      const p = await postJson<UnbuildResult>("/api/unbuild", { ...scope, includePosted, preview: true });
      modal.confirm({
        title: includePosted ? "Unpost + Unbuild?" : "Unbuild?",
        content: (
          <Space orientation="vertical">
            {p.unposted && (
              <span>
                Unpost: {p.unposted.events} event, xóa {p.unposted.glLines} dòng GL ({p.unposted.documents} chứng từ)
              </span>
            )}
            <span>Xóa {p.deletedEvents} AccountingEvent</span>
            <span>{p.rawRowsReset} dòng raw về NOT_BUILT</span>
            {p.postedEventsKept > 0 && <Alert type="warning" showIcon title={`${p.postedEventsKept} event đã POSTED sẽ giữ lại (cần Unpost trước)`} />}
          </Space>
        ),
        okText: "Chạy",
        okButtonProps: { danger: true },
        onOk: async () => {
          await postJson("/api/unbuild", { ...scope, includePosted });
          message.success("Đã xong");
          await list.reload();
        },
      });
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <div>
        <Typography.Title level={3} style={{ marginBottom: 4 }}>
          2. AccountingEvent
        </Typography.Title>
        <Typography.Text type="secondary">
          Build chuyển dòng raw thành event chuẩn hóa (chưa tách Nợ/Có, chưa ghi sổ). Orders: mỗi đơn fulfilled → tối đa 4 event (PRODUCT, SHIPADD,
          TAX, SELLER_PROFIT). PayPal/Stripe/PIPO/AccountingSource: mỗi dòng raw → 1 event cho mỗi JournalLineRule active. Chọn nguồn ở ô
          &quot;Nguồn&quot; rồi bấm Build; để trống là Orders. Bấm 1 dòng để xem chi tiết &amp; truy vết.
        </Typography.Text>
      </div>

      <Card title="Phạm vi & thao tác">
        <Space wrap>
          <ScopeBar value={scope} onChange={setScope} options={options} />
          <Button type="primary" icon={<BuildOutlined />} loading={busy === "build"} onClick={build}>
            Build {scope.dataSource ?? "ORDERS"}
          </Button>
          <Button icon={<RollbackOutlined />} loading={busy === "unbuild"} onClick={() => unbuildFlow(false)}>
            Unbuild
          </Button>
          <Button danger icon={<RollbackOutlined />} loading={busy === "unpostUnbuild"} onClick={() => unbuildFlow(true)}>
            Unpost + Unbuild
          </Button>
          <Button icon={<DownloadOutlined />} href={`/api/events/export${query}`}>
            Export Excel
          </Button>
        </Space>
      </Card>

      <Card title="Tổng hợp theo nghiệp vụ" size="small">
        <Table
          size="small"
          pagination={false}
          rowKey={(r) => `${r.JournalTypeCode}-${r.PostStatus}`}
          dataSource={list.data?.summary}
          columns={[
            { title: "JournalTypeCode", dataIndex: "JournalTypeCode" },
            { title: "PostStatus", dataIndex: "PostStatus", render: (v) => <StatusTag value={v} /> },
            { title: "Số event", dataIndex: "Events", align: "right" },
            { title: "Σ Amount", dataIndex: "Amount", align: "right", render: (v) => <span className="num">{money(v)}</span> },
          ]}
        />
      </Card>

      <Card>
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Space wrap>
            <Select
              allowClear
              placeholder="JournalTypeCode"
              style={{ width: 280 }}
              options={options?.journalTypeCodes.filter((j) => j.dataSource === "ORDERS").map((j) => ({ value: j.value, label: j.value }))}
              onChange={(journalTypeCode) => setFilter({ ...filter, journalTypeCode })}
            />
            <Select
              allowClear
              placeholder="PostStatus"
              style={{ width: 140 }}
              options={["NEW", "POSTED", "ERROR", "SKIPPED"].map((v) => ({ value: v, label: v }))}
              onChange={(postStatus) => setFilter({ ...filter, postStatus })}
            />
            <Input.Search
              allowClear
              placeholder="TransactionID / OrderID / Partner / DocNum"
              style={{ width: 320 }}
              onSearch={(search) => {
                setFilter({ ...filter, search });
                setPage({ ...page, page: 1 });
              }}
            />
            <Button icon={<ReloadOutlined />} onClick={list.reload} />
          </Space>
          <Table<AccountingEventRow>
            size="small"
            rowKey="AccountingEventID"
            loading={list.loading}
            columns={columns}
            dataSource={list.data?.rows}
            scroll={{ x: "max-content" }}
            rowClassName={() => "clickable-row"}
            onRow={(r) => ({ onClick: () => setDetailId(r.AccountingEventID) })}
            pagination={{
              current: page.page,
              pageSize: page.pageSize,
              total: list.data?.total,
              showSizeChanger: true,
              pageSizeOptions: [50, 100, 500],
              showTotal: (t) => `${t} event`,
              onChange: (p, s) => setPage({ page: p, pageSize: s }),
            }}
          />
        </Space>
      </Card>

      <Drawer size={960} open={!!detailId} onClose={() => setDetailId(null)} title={`AccountingEvent #${detailId ?? ""}`} loading={detail.loading}>
        {detail.data && <EventDetailView d={detail.data} />}
      </Drawer>
    </Space>
  );
}

function EventDetailView({ d }: { d: EventDetail }) {
  const e = d.event;
  const item = (label: string, v: unknown) => ({ label, children: v === null || v === undefined || v === "" ? "—" : String(v) });
  return (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      {e.ErrorMessage && <Alert type={e.PostStatus === "SKIPPED" ? "info" : "error"} showIcon title={`${e.ErrorStage ?? ""} ${e.ErrorMessage}`} />}
      <Descriptions
        title="Event"
        size="small"
        bordered
        column={2}
        items={[
          item("JournalTypeCode", e.JournalTypeCode),
          { label: "PostStatus", children: <StatusTag value={e.PostStatus} /> },
          item("TransactionID", e.TransactionID),
          item("EventSeq / PairCode", `${e.EventSeq} / ${e.PairCode}`),
          item("PostingDate / Period", `${e.PostingDate} / ${e.Period}`),
          item("ComCode", e.ComCode),
          { label: "Amount", children: <b className="num">{money(e.Amount)} {e.InputCurr}</b> },
          item("AmountSource", e.AmountSource),
          item("ContraAccount", e.ContraAccount),
          item("TransAccount", e.TransAccount),
          item("Partner", `${e.PartnerCode ?? ""} ${e.PartnerName ? `(${e.PartnerName})` : ""}`),
          item("PartnerTaxID", e.PartnerTaxID),
          item("PostedDocNum", e.PostedDocNum),
          item("PostBatchID", e.PostBatchID),
        ]}
      />
      {d.rule && (
        <Descriptions
          title="Rule áp dụng khi Post (JournalLineRule)"
          size="small"
          bordered
          column={2}
          items={[
            item("Nợ = NormalDrAccountSource", `${d.rule.NormalDrAccountSource} → ${accountOf(d.rule.NormalDrAccountSource, e)}`),
            item("Có = NormalCrAccountSource", `${d.rule.NormalCrAccountSource} → ${accountOf(d.rule.NormalCrAccountSource, e)}`),
            item("AmountFactor", d.rule.AmountFactor),
            item("NegativeMode", d.rule.NegativeMode),
            item("PartnerMode", `${d.rule.PartnerMode}${d.rule.FixedPartner ? ` = ${d.rule.FixedPartner}` : ""}`),
            item("MemoTemplate", d.rule.MemoTemplate),
            item("JournalType.Classify", d.journalType?.Classify),
            item("JournalType.Partner", d.journalType?.Partner),
          ]}
        />
      )}
      <div>
        <Typography.Title level={5}>Raw order nguồn ({d.orders.length} item)</Typography.Title>
        <Table
          size="small"
          rowKey="RawOrderID"
          pagination={false}
          dataSource={d.orders}
          scroll={{ x: "max-content" }}
          columns={columnsOf<RawOrderRow>(["ItemCode", "ItemStatus", "FulfilledAt", "Quantity", "UnitPrice", "ShippingFee", "AdditionalCost", "TaxFee", "Profit", "SellerEmail", "StoreName", "PaymentGatewayName"])}
        />
      </div>
      {d.glLines.length > 0 && (
        <div>
          <Typography.Title level={5}>Chứng từ GL {e.PostedDocNum}</Typography.Title>
          <Table
            size="small"
            rowKey="ID"
            pagination={false}
            dataSource={d.glLines}
            scroll={{ x: "max-content" }}
            columns={columnsOf<GLTransRow>(["AccountCode", "BalanceImpact", "PartnerCode", "InputDr", "InputCr", "AccountedDr", "AccountedCr", "Description"], GL_FIELD_DOCS)}
          />
        </div>
      )}
    </Space>
  );
}

function accountOf(source: string | null, e: AccountingEventRow) {
  switch (source) {
    case "BANK_ACCOUNT":
      return e.BankGLAccount ?? "—";
    case "CONTRA_ACCOUNT":
      return e.ContraAccount ?? "—";
    case "TRANS_ACCOUNT":
      return e.TransAccount ?? "—";
    case "FEE_ACCOUNT":
      return e.FeeAccount ?? "—";
    default:
      return "—";
  }
}
