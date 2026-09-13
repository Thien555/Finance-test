"use client";

import { DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Card, Col, Collapse, Drawer, Input, Row, Select, Space, Statistic, Table, Tabs, Tag, Typography } from "antd";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { money, toQuery, useApi, useOptions } from "@/components/client";
import { columnsOf, type ScopeValue, ScopeBar } from "@/components/ui";
import type { AccountingEventRow, GLTransRow, RawOrderRow } from "@/lib/db/schema";
import { EVENT_FIELD_DOCS, GL_FIELD_DOCS } from "@/lib/field-docs";
import { GL_EXPORT_COLUMNS } from "@/lib/gl-columns";

interface GlList {
  rows: GLTransRow[];
  total: number;
  totals: { Documents: number; InputDr: number; InputCr: number; AccountedDr: number; AccountedCr: number };
}

interface AccountSummary {
  AccountCode: string;
  AccountName: string | null;
  AccountType: string | null;
  Lines: number;
  AccountedDr: number;
  AccountedCr: number;
  Balance: number;
}

interface DocDetail {
  docNum: string;
  lines: GLTransRow[];
  events: AccountingEventRow[];
  orders: RawOrderRow[];
}

interface GlFilterState {
  journalTypeCode?: string;
  accountCode?: string;
  docNum?: string;
  postBatchId?: number;
  partner?: string;
  balanceImpact?: string;
}

export default function GlPage() {
  return (
    <Suspense>
      <GlContent />
    </Suspense>
  );
}

function GlContent() {
  const params = useSearchParams();
  const { data: options } = useOptions();
  const [scope, setScope] = useState<ScopeValue>({});
  const [filter, setFilter] = useState<GlFilterState>(() => {
    const id = Number(params.get("postBatchId"));
    return id ? { postBatchId: id } : {};
  });
  const [page, setPage] = useState({ page: 1, pageSize: 100 });
  const [docNum, setDocNum] = useState<string | null>(null);

  const query = toQuery({ ...scope, ...filter });
  const list = useApi<GlList>(`/api/gl${toQuery({ ...scope, ...filter, ...page })}`);
  const summary = useApi<AccountSummary[]>(`/api/gl/summary${query}`);
  const doc = useApi<DocDetail>(docNum ? `/api/gl/doc${toQuery({ docNum })}` : null);

  const columns = useMemo(
    () =>
      columnsOf<GLTransRow>(GL_EXPORT_COLUMNS, GL_FIELD_DOCS, {
        ID: { fixed: "left", width: 80 },
        DocNum: { fixed: "left" },
      }),
    [],
  );

  const t = list.data?.totals;
  const balanced = t ? Math.abs(t.AccountedDr - t.AccountedCr) < 0.005 : true;
  const reload = () => Promise.all([list.reload(), summary.reload()]);
  const update = (patch: GlFilterState) => {
    setFilter({ ...filter, ...patch });
    setPage({ ...page, page: 1 });
  };

  return (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <div>
        <Typography.Title level={3} style={{ marginBottom: 4 }}>
          4. GLTrans – Sổ cái
        </Typography.Title>
        <Typography.Text type="secondary">
          Output cuối của engine. Mỗi dòng là 1 vế Nợ/Có; các dòng cùng DocNum luôn cân. Rê chuột lên tiêu đề cột để xem giải thích, bấm 1 dòng để truy vết
          về AccountingEvent và order gốc.
        </Typography.Text>
      </div>

      <Card>
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Space wrap>
            <ScopeBar
              value={scope}
              onChange={(v) => {
                setScope(v);
                setPage({ ...page, page: 1 });
              }}
              options={options}
            />
            <Select
              allowClear
              placeholder="JournalTypeCode"
              style={{ width: 280 }}
              value={filter.journalTypeCode}
              options={options?.journalTypeCodes.map((j) => ({ value: j.value, label: j.value }))}
              onChange={(journalTypeCode) => update({ journalTypeCode })}
              showSearch
            />
            <Select
              allowClear
              placeholder="PostBatchID"
              style={{ width: 170 }}
              value={filter.postBatchId}
              options={options?.postBatches.map((b) => ({ value: b.value, label: `#${b.value} ${b.classify} (${b.status})` }))}
              onChange={(postBatchId) => update({ postBatchId })}
            />
            <Select
              allowClear
              placeholder="Nợ/Có"
              style={{ width: 110 }}
              value={filter.balanceImpact}
              options={["Debit", "Credit"].map((v) => ({ value: v, label: v }))}
              onChange={(balanceImpact) => update({ balanceImpact })}
            />
          </Space>
          <Space wrap>
            <Input.Search allowClear placeholder="AccountCode (bắt đầu bằng)" style={{ width: 220 }} onSearch={(accountCode) => update({ accountCode })} />
            <Input.Search allowClear placeholder="DocNum" style={{ width: 220 }} onSearch={(v) => update({ docNum: v })} />
            <Input.Search allowClear placeholder="Partner / TaxID" style={{ width: 240 }} onSearch={(partner) => update({ partner })} />
            <Button icon={<ReloadOutlined />} onClick={reload} />
            <Button type="primary" icon={<DownloadOutlined />} href={`/api/gl/export${query}`}>
              Export Excel ({list.data?.total ?? 0} dòng)
            </Button>
          </Space>
        </Space>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={12} md={8} xl={4}>
          <Card size="small">
            <Statistic title="Dòng GL" value={list.data?.total ?? 0} />
          </Card>
        </Col>
        <Col xs={12} md={8} xl={4}>
          <Card size="small">
            <Statistic title="Chứng từ (DocNum)" value={t?.Documents ?? 0} />
          </Card>
        </Col>
        <Col xs={12} md={8} xl={4}>
          <Card size="small">
            <Statistic title="Σ InputDr" value={money(t?.InputDr ?? 0)} />
          </Card>
        </Col>
        <Col xs={12} md={8} xl={4}>
          <Card size="small">
            <Statistic title="Σ InputCr" value={money(t?.InputCr ?? 0)} />
          </Card>
        </Col>
        <Col xs={12} md={8} xl={4}>
          <Card size="small">
            <Statistic title="Σ AccountedDr" value={money(t?.AccountedDr ?? 0)} />
          </Card>
        </Col>
        <Col xs={12} md={8} xl={4}>
          <Card size="small">
            <Statistic
              title="Σ AccountedCr"
              value={money(t?.AccountedCr ?? 0)}
              suffix={<Tag color={balanced ? "green" : "red"}>{balanced ? "Cân" : "Lệch"}</Tag>}
            />
          </Card>
        </Col>
      </Row>

      <Card>
        <Tabs
          items={[
            {
              key: "lines",
              label: "Chi tiết GLTrans",
              children: (
                <Table<GLTransRow>
                  size="small"
                  rowKey="ID"
                  loading={list.loading}
                  columns={columns}
                  dataSource={list.data?.rows}
                  scroll={{ x: "max-content" }}
                  rowClassName={() => "clickable-row"}
                  onRow={(r) => ({ onClick: () => setDocNum(r.DocNum) })}
                  pagination={{
                    current: page.page,
                    pageSize: page.pageSize,
                    total: list.data?.total,
                    showSizeChanger: true,
                    pageSizeOptions: [100, 500, 1000],
                    showTotal: (n) => `${n} dòng`,
                    onChange: (p, s) => setPage({ page: p, pageSize: s }),
                  }}
                />
              ),
            },
            {
              key: "accounts",
              label: "Tổng hợp theo tài khoản",
              children: (
                <Table<AccountSummary>
                  size="small"
                  rowKey="AccountCode"
                  loading={summary.loading}
                  dataSource={summary.data ?? []}
                  pagination={false}
                  columns={[
                    { title: "AccountCode", dataIndex: "AccountCode", width: 120 },
                    { title: "Tên tài khoản (CoA)", dataIndex: "AccountName" },
                    { title: "Loại", dataIndex: "AccountType", width: 70 },
                    { title: "Số dòng", dataIndex: "Lines", width: 90, align: "right" },
                    { title: "Phát sinh Nợ", dataIndex: "AccountedDr", align: "right", render: (v) => <span className="num">{money(v)}</span> },
                    { title: "Phát sinh Có", dataIndex: "AccountedCr", align: "right", render: (v) => <span className="num">{money(v)}</span> },
                    { title: "Nợ − Có", dataIndex: "Balance", align: "right", render: (v) => <span className="num">{money(v)}</span> },
                  ]}
                  summary={(rows) => {
                    const dr = rows.reduce((a, r) => a + r.AccountedDr, 0);
                    const cr = rows.reduce((a, r) => a + r.AccountedCr, 0);
                    return (
                      <Table.Summary.Row>
                        <Table.Summary.Cell index={0} colSpan={4}>
                          <b>Tổng</b>
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={4} align="right">
                          <b className="num">{money(dr)}</b>
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={5} align="right">
                          <b className="num">{money(cr)}</b>
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={6} align="right">
                          <b className="num">{money(dr - cr)}</b>
                        </Table.Summary.Cell>
                      </Table.Summary.Row>
                    );
                  }}
                />
              ),
            },
          ]}
        />
      </Card>

      <Collapse
        items={[
          {
            key: "docs",
            label: "Giải nghĩa các cột GLTrans",
            children: (
              <Table
                size="small"
                pagination={false}
                rowKey="field"
                dataSource={GL_EXPORT_COLUMNS.map((field) => ({ field, doc: GL_FIELD_DOCS[field] }))}
                columns={[
                  { title: "Cột", dataIndex: "field", width: 180, render: (v) => <Typography.Text code>{v}</Typography.Text> },
                  { title: "Ý nghĩa / cách tính", dataIndex: "doc" },
                ]}
              />
            ),
          },
        ]}
      />

      <Drawer size={1100} open={!!docNum} onClose={() => setDocNum(null)} title={`Chứng từ ${docNum ?? ""}`} loading={doc.loading}>
        {doc.data && <DocDetailView d={doc.data} />}
      </Drawer>
    </Space>
  );
}

function DocDetailView({ d }: { d: DocDetail }) {
  const dr = d.lines.reduce((a, l) => a + l.AccountedDr, 0);
  const cr = d.lines.reduce((a, l) => a + l.AccountedCr, 0);
  return (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <div>
        <Typography.Title level={5}>
          Dòng GL ({d.lines.length}) · Nợ {money(dr)} · Có {money(cr)}
        </Typography.Title>
        <Table
          size="small"
          rowKey="ID"
          pagination={false}
          dataSource={d.lines}
          scroll={{ x: "max-content" }}
          columns={columnsOf<GLTransRow>(
            ["AccountCode", "BalanceImpact", "PartnerCode", "PartnerTaxID", "InputDr", "InputCr", "XRate", "AccountedDr", "AccountedCr", "Description", "PostingGroupKey"],
            GL_FIELD_DOCS,
          )}
        />
      </div>
      <div>
        <Typography.Title level={5}>AccountingEvent tạo nên chứng từ ({d.events.length})</Typography.Title>
        <Table
          size="small"
          rowKey="AccountingEventID"
          dataSource={d.events}
          pagination={{ pageSize: 20 }}
          scroll={{ x: "max-content" }}
          columns={columnsOf<AccountingEventRow>(
            ["AccountingEventID", "TransactionID", "OrderID", "PostingDate", "AmountSource", "Amount", "PartnerCode", "PartnerName", "ContraAccount", "TransAccount"],
            EVENT_FIELD_DOCS,
          )}
          summary={(rows) => (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={5}>
                <b>Σ Amount</b>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={5} align="right">
                <b className="num">{money(rows.reduce((a, r) => a + r.Amount, 0))}</b>
              </Table.Summary.Cell>
            </Table.Summary.Row>
          )}
        />
      </div>
      <div>
        <Typography.Title level={5}>Raw order gốc ({d.orders.length} item)</Typography.Title>
        <Table
          size="small"
          rowKey="RawOrderID"
          dataSource={d.orders}
          pagination={{ pageSize: 20 }}
          scroll={{ x: "max-content" }}
          columns={columnsOf<RawOrderRow>(["OrderId", "ItemCode", "ItemStatus", "FulfilledAt", "Quantity", "UnitPrice", "ShippingFee", "AdditionalCost", "TaxFee", "Profit", "SellerEmail", "StoreName", "PaymentGatewayName"])}
        />
      </div>
    </Space>
  );
}
