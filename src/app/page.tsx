"use client";

import { DeleteOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { App, Button, Card, Col, Collapse, Popconfirm, Row, Space, Statistic, Steps, Table, Tag, Typography } from "antd";
import Link from "next/link";
import { useState } from "react";
import { money, postJson, useApi } from "@/components/client";
import { StatusTag } from "@/components/ui";
import type { BuildBatchRow, ImportBatchRow, PostingBatchRow } from "@/lib/db/schema";
import { SOURCE_KEYS, SOURCE_META } from "@/lib/sources/columns";

interface Dashboard {
  raw: Record<string, number>;
  rawBySource: Record<string, Record<string, number>>;
  eventsBySource: Record<string, number>;
  glBySource: Record<string, number>;
  rawTotal: number;
  events: Record<string, number>;
  eventsTotal: number;
  gl: { lines: number; docs: number; dr: number; cr: number };
  exceptions: Record<string, number>;
  imports: ImportBatchRow[];
  builds: BuildBatchRow[];
  posts: PostingBatchRow[];
}

const { Title, Paragraph, Text } = Typography;

/** Orders + 4 nguồn ngoài Orders, dùng cho dãy thẻ tổng quan */
interface SourceCard {
  key: string;
  href: string;
  label: string;
  dataSource: string;
}
const SOURCE_CARDS: SourceCard[] = [
  { key: "orders", href: "/raw/orders", label: "Orders", dataSource: "ORDERS" },
  ...SOURCE_KEYS.map((k) => ({ key: k, href: `/raw/${k}`, label: SOURCE_META[k].label, dataSource: SOURCE_META[k].dataSource })),
];

export default function DashboardPage() {
  const { message, modal } = App.useApp();
  const { data, reload, loading } = useApi<Dashboard>("/api/dashboard");
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<unknown>, done: (r: never) => string) => {
    setBusy(key);
    try {
      const r = await fn();
      message.success(done(r as never));
      await reload();
    } catch (e) {
      modal.error({ title: "Lỗi", content: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const d = data;
  const balanced = d ? Math.abs(d.gl.dr - d.gl.cr) < 0.005 : true;

  return (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <div>
        <Title level={3} style={{ marginBottom: 4 }}>
          Accounting Engine: Orders → GLTrans
        </Title>
        <Text type="secondary">Upload order thô → Build AccountingEvent → Post (sinh PostingBatch) → Sổ cái GLTrans + Export Excel</Text>
      </div>

      <Card>
        <Steps
          items={[
            {
              title: <Link href="/raw/orders">1. Upload</Link>,
              content: `${d?.rawTotal ?? 0} dòng raw order`,
              status: d?.rawTotal ? "finish" : "process",
            },
            {
              title: <Link href="/events">2. Build</Link>,
              content: `${d?.eventsTotal ?? 0} AccountingEvent`,
              status: d?.eventsTotal ? "finish" : "wait",
            },
            {
              title: <Link href="/posting">3. Post</Link>,
              content: `${d?.events.POSTED ?? 0} event đã post`,
              status: d?.events.POSTED ? "finish" : "wait",
            },
            {
              title: <Link href="/gl">4. GLTrans</Link>,
              content: `${d?.gl.lines ?? 0} dòng sổ cái`,
              status: d?.gl.lines ? "finish" : "wait",
            },
          ]}
        />
        <Space wrap style={{ marginTop: 20 }}>
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            loading={busy === "cycle"}
            onClick={() =>
              run(
                "cycle",
                () => postJson("/api/cycle"),
                (r: { build: { EventsCreated: number; EventsReplaced: number }; post: { InsertedRows: number }[] }) =>
                  `Build: +${r.build.EventsCreated} event (thay ${r.build.EventsReplaced}) · Post: ${r.post.reduce((a, p) => a + p.InsertedRows, 0)} dòng GL`,
              )
            }
          >
            Chạy full cycle (Build + Post)
          </Button>
          <Popconfirm
            title="Xóa toàn bộ dữ liệu test?"
            description="Xóa raw order, event, GL, batch, exception. Giữ nguyên master data."
            onConfirm={() => run("reset", () => postJson("/api/reset"), () => "Đã xóa dữ liệu test")}
          >
            <Button danger icon={<DeleteOutlined />} loading={busy === "reset"}>
              Xóa dữ liệu test
            </Button>
          </Popconfirm>
        </Space>
      </Card>

      <Card
        title="Các nguồn dữ liệu"
        extra={<Text type="secondary">Mỗi nguồn có trang upload riêng; Build/Post chọn nguồn ở ô &quot;Nguồn&quot;.</Text>}
        loading={loading && !d}
      >
        <Row gutter={[12, 12]}>
          {SOURCE_CARDS.map((src) => {
            const byStatus = src.key === "orders" ? (d?.raw ?? {}) : (d?.rawBySource?.[src.key] ?? {});
            const rawTotal = Object.values(byStatus).reduce((a, b) => a + b, 0);
            return (
              <Col key={src.key} xs={24} sm={12} lg={8} xl={4}>
                <Card size="small" title={<Link href={src.href}>{src.label}</Link>}>
                  <Statistic value={rawTotal} suffix="dòng raw" valueStyle={{ fontSize: 20 }} />
                  <Space size={4} wrap style={{ marginTop: 6 }}>
                    {Object.entries(byStatus).map(([k, v]) => (
                      <Tag key={k}>
                        {k}: {v}
                      </Tag>
                    ))}
                  </Space>
                  <div style={{ marginTop: 6 }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {d?.eventsBySource?.[src.dataSource] ?? 0} event · {d?.glBySource?.[src.dataSource] ?? 0} dòng GL
                    </Text>
                  </div>
                </Card>
              </Col>
            );
          })}
        </Row>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={12} lg={6}>
          <Card loading={loading && !d}>
            <Statistic title="Raw order" value={d?.rawTotal ?? 0} />
            <Space size={4} wrap>
              {Object.entries(d?.raw ?? {}).map(([k, v]) => (
                <Tag key={k}>
                  {k}: {v}
                </Tag>
              ))}
            </Space>
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card loading={loading && !d}>
            <Statistic title="AccountingEvent" value={d?.eventsTotal ?? 0} />
            <Space size={4} wrap>
              {Object.entries(d?.events ?? {}).map(([k, v]) => (
                <Tag key={k} color={k === "POSTED" ? "green" : k === "ERROR" ? "red" : k === "NEW" ? "blue" : undefined}>
                  {k}: {v}
                </Tag>
              ))}
            </Space>
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card loading={loading && !d}>
            <Statistic title="GLTrans (dòng / chứng từ)" value={`${d?.gl.lines ?? 0} / ${d?.gl.docs ?? 0}`} />
            <Text type="secondary" className="num">
              Nợ {money(d?.gl.dr)} · Có {money(d?.gl.cr)}
            </Text>{" "}
            <Tag color={balanced ? "green" : "red"}>{balanced ? "Cân" : "Lệch"}</Tag>
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card loading={loading && !d}>
            <Statistic title={<Link href="/exceptions">Exceptions</Link>} value={Object.values(d?.exceptions ?? {}).reduce((a, b) => a + b, 0)} />
            <Space size={4} wrap>
              {Object.entries(d?.exceptions ?? {}).map(([k, v]) => (
                <Tag key={k} color={k === "ERROR" ? "red" : k === "WARNING" ? "orange" : undefined}>
                  {k}: {v}
                </Tag>
              ))}
            </Space>
          </Card>
        </Col>
      </Row>

      <Collapse
        defaultActiveKey={["flow"]}
        items={[
          { key: "flow", label: "Giải thích luồng: AccountingEvent và PostingBatch để làm gì?", children: <FlowExplain /> },
          { key: "formula", label: "Công thức Orders → GLTrans (theo cấu hình JournalType + JournalLineRule)", children: <FormulaExplain /> },
          { key: "batches", label: "Lần chạy gần đây", children: <RecentBatches d={d} /> },
        ]}
      />
    </Space>
  );
}

function FlowExplain() {
  return (
    <Space orientation="vertical" size={8} style={{ width: "100%" }}>
      <pre className="formula" style={{ padding: 12, overflowX: "auto" }}>
        {`File order ──(1) Import──► RawOrders ──(2) Build──► AccountingEvent ──(3) Post──► GLTrans
                               │                       (PostStatus=NEW)         │
                          ImportBatch              BuildBatch + Exception     PostingBatch`}
      </pre>
      <Table
        size="small"
        pagination={false}
        rowKey="layer"
        columns={[
          { title: "Lớp", dataIndex: "layer", width: 160, render: (v) => <b>{v}</b> },
          { title: "Là gì", dataIndex: "what" },
          { title: "Tại sao cần", dataIndex: "why" },
        ]}
        dataSource={[
          { layer: "RawOrders", what: "Bản sao file upload, mỗi dòng = 1 item (khóa ItemCode).", why: "Truy vết ngược về dữ liệu gốc." },
          {
            layer: "AccountingEvent",
            what: "“Event nghiệp vụ chuẩn hóa”: 1 dòng = 1 giao dịch × 1 JournalLineRule. Đã có ComCode, ngày, kỳ, số tiền signed, các TK (Contra/Trans/Bank/Fee), partner — nhưng CHƯA tách Nợ/Có.",
            why: "Lớp kiểm tra trước khi ghi sổ: thấy lỗi (thiếu seller, thiếu rule…), sửa mapping rồi Build lại mà không đụng sổ cái.",
          },
          {
            layer: "PostingBatch",
            what: "Nhật ký 1 lần bấm Post: phạm vi, Single/Bulk, thời gian, trạng thái, số dòng GL đã ghi.",
            why: "Audit + Unpost theo lô; mỗi dòng GL biết mình sinh ra từ lần post nào (PostBatchID).",
          },
          { layer: "GLTrans", what: "Sổ cái: mỗi dòng là 1 vế Nợ hoặc Có; mỗi chứng từ (DocNum) luôn cân.", why: "Output cuối để làm báo cáo." },
        ]}
      />
    </Space>
  );
}

function FormulaExplain() {
  return (
    <Space orientation="vertical" size={12} style={{ width: "100%" }}>
      <Paragraph style={{ marginBottom: 0 }}>
        <b>Build:</b> chỉ lấy <span className="formula">ItemStatus = FULFILLED</span> có FulfilledAt →{" "}
        <span className="formula">ComCode = GatewayCompanyMapping(PaymentGatewayName)</span> →{" "}
        <span className="formula">PostingDate = FulfilledAt</span> → gom theo <span className="formula">ComCode + OrderId + PostingDate</span> → mỗi nghiệp vụ
        dưới đây sinh 1 event (amount = 0 thì bỏ qua).
      </Paragraph>
      <Table
        size="small"
        pagination={false}
        rowKey="jtc"
        scroll={{ x: 900 }}
        columns={[
          { title: "JournalTypeCode", dataIndex: "jtc", render: (v) => <Text code>{v}</Text> },
          { title: "Amount", dataIndex: "amount", render: (v) => <span className="formula">{v}</span> },
          { title: "Nợ (Debit)", dataIndex: "dr" },
          { title: "Có (Credit)", dataIndex: "cr" },
          { title: "Partner", dataIndex: "partner" },
        ]}
        dataSource={[
          { jtc: "ORD_REV_PRODUCT_FULFILLED", amount: "Σ Quantity × UnitPrice", dr: "CONTRA 13122001 Người mua trả tiền trước", cr: "TRANS 51112001 Doanh thu bán hàng", partner: "INDIVIDUALS" },
          { jtc: "ORD_REV_SHIPADD_FULFILLED", amount: "Σ ShippingFee + AdditionalCost", dr: "CONTRA 13122001", cr: "TRANS 51131001 Doanh thu shipping", partner: "INDIVIDUALS" },
          { jtc: "ORD_REV_TAX_FULFILLED", amount: "Σ TaxFee", dr: "CONTRA 13122001", cr: "TRANS 33302001 Thuế phải nộp", partner: "INDIVIDUALS" },
          { jtc: "ORD_SELLER_PROFIT_FULFILLED", amount: "Σ Profit", dr: "TRANS 63202001 Giá vốn – SellerCost", cr: "CONTRA 33102001 Phải trả Seller", partner: "Seller: TaxID → SellerEmail (+StoreName)" },
        ]}
      />
      <Paragraph style={{ marginBottom: 0 }}>
        <b>Post:</b> join rule theo <span className="formula">JournalTypeCode + RuleSeq = EventSeq</span> → TK Nợ/Có theo{" "}
        <span className="formula">NormalDr/CrAccountSource</span> → <span className="formula">Amount × AmountFactor</span> → NegativeMode (SIGNED giữ dấu /
        REVERSE đảo vế / ERROR báo lỗi) → FX (<span className="formula">cùng tiền: XRate = 1</span>) → Single: mỗi event 1 chứng từ{" "}
        <span className="formula">ASI-yyyyMMdd-EventID</span>; Bulk: gom theo <span className="formula">PostingGroupKey</span> rồi cộng theo TK →{" "}
        <span className="formula">ASB-yyyyMMdd-MinEventID</span>. Toàn bộ nghiệp vụ Orders đang cấu hình <b>Bulk</b>.
      </Paragraph>
    </Space>
  );
}

function RecentBatches({ d }: { d: Dashboard | null }) {
  return (
    <Row gutter={16}>
      <Col xs={24} lg={8}>
        <Title level={5}>Import</Title>
        <Table
          size="small"
          pagination={false}
          rowKey="ImportBatchID"
          dataSource={d?.imports}
          columns={[
            { title: "ID", dataIndex: "ImportBatchID", width: 50 },
            { title: "File", dataIndex: "FileName", ellipsis: true },
            { title: "Status", dataIndex: "Status", render: (v) => <StatusTag value={v} /> },
            { title: "OK/Lỗi", render: (_, r) => `${r.SuccessRows}/${r.ErrorRows}` },
          ]}
        />
      </Col>
      <Col xs={24} lg={8}>
        <Title level={5}>Build</Title>
        <Table
          size="small"
          pagination={false}
          rowKey="BuildBatchID"
          dataSource={d?.builds}
          columns={[
            { title: "ID", dataIndex: "BuildBatchID", width: 50 },
            { title: "Bắt đầu", dataIndex: "StartedAt" },
            { title: "Status", dataIndex: "Status", render: (v) => <StatusTag value={v} /> },
            { title: "Tạo/Thay", render: (_, r) => `${r.EventsCreated}/${r.EventsReplaced}` },
          ]}
        />
      </Col>
      <Col xs={24} lg={8}>
        <Title level={5}>Post</Title>
        <Table
          size="small"
          pagination={false}
          rowKey="PostBatchID"
          dataSource={d?.posts}
          columns={[
            { title: "ID", dataIndex: "PostBatchID", width: 50 },
            { title: "Loại", dataIndex: "Classify", render: (v) => <StatusTag value={v} /> },
            { title: "Status", dataIndex: "Status", render: (v) => <StatusTag value={v} /> },
            { title: "Dòng GL", dataIndex: "InsertedRows" },
          ]}
        />
      </Col>
    </Row>
  );
}
