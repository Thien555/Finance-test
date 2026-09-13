"use client";

import { CloudSyncOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import { Alert, App, AutoComplete, Button, Card, Form, Input, Modal, Popconfirm, Space, Switch, Table, Tabs, Typography } from "antd";
import { useState } from "react";
import { deleteJson, postJson, toQuery, useApi } from "@/components/client";
import { columnsOf } from "@/components/ui";
import type { CompanyRow, GatewayCompanyMappingRow } from "@/lib/db/schema";

const VIEW_TABLES: { key: string; label: string; fields: string[]; note?: string }[] = [
  {
    key: "journalType",
    label: "JournalType",
    fields: ["JournalTypeID", "DataSource", "JournalType", "JournalTypeCode", "BankAccount", "ContraAccount", "TransAccount", "FeeAccount", "Partner", "Classify", "GroupRule"],
    note: "Map DataSource + loại giao dịch gốc → JournalTypeCode, TK mặc định, Partner rule, Single/Bulk.",
  },
  {
    key: "journalLineRule",
    label: "JournalLineRule",
    fields: ["JournalLineRuleID", "JournalTypeCode", "RuleSeq", "PairCode", "NormalDrAccountSource", "NormalCrAccountSource", "AmountSource", "AmountFactor", "NegativeMode", "SkipIfDrAccountNull", "SkipIfCrAccountNull", "SkipIfAmountZero", "PartnerMode", "FixedPartner", "ApplyPartnerToDrLine", "ApplyPartnerToCrLine", "MemoTemplate", "IsActive"],
    note: "Mỗi rule = 1 cặp Nợ/Có: lấy TK nào (NormalDr/CrAccountSource), số tiền nào (AmountSource × AmountFactor), xử lý số âm.",
  },
  { key: "partners", label: "Partners", fields: ["PartnerID", "PartnerType", "PartnerTaxID", "PartnerCode", "PartnerName", "BankAccount", "BankType", "IsActive"], note: "Seller: PartnerCode = email, PartnerName = FFT-{Store}, PartnerTaxID = mã định danh." },
  { key: "coa", label: "CoA", fields: ["CoAID", "AccountCode", "AccountName", "AccountType", "BalanceSide", "Status", "ARAP", "ARAPType"] },
  { key: "exrate", label: "Exrate", fields: ["ExrateID", "Period", "ExrateDate", "ReportCurrency", "TransCurrency", "RateType", "Exrate", "SourceNote", "IsActive"], note: "ReportCurrency = FncCurr, TransCurrency = InputCurr." },
  { key: "mappingBankAccount", label: "MappingBankAccount", fields: ["ID", "ComCode", "BankAccountNumber", "InputCurr", "GLAccountCode", "BankName", "IsActive"] },
];

export default function MasterPage() {
  const { message, modal } = App.useApp();
  const [syncing, setSyncing] = useState(false);
  const [version, setVersion] = useState(0);

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await postJson<{ counts: Record<string, number> }>("/api/master/sync");
      modal.success({
        title: "Đã sync từ Google Sheet",
        content: (
          <ul>
            {Object.entries(r.counts).map(([k, v]) => (
              <li key={k}>
                {k}: {v} dòng
              </li>
            ))}
          </ul>
        ),
      });
      setVersion((v) => v + 1);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <div>
        <Typography.Title level={3} style={{ marginBottom: 4 }}>
          Master data
        </Typography.Title>
        <Typography.Text type="secondary">Cấu hình điều khiển engine. Sửa trên Google Sheet rồi bấm Sync; lần Build/Post sau sẽ dùng cấu hình mới.</Typography.Text>
      </div>

      <Card>
        <Space wrap>
          <Popconfirm
            title="Sync 6 sheet master từ Google Sheet?"
            description="Thay toàn bộ Partners, JournalType, JournalLineRule, CoA, Exrate, MappingBankAccount và cập nhật snapshot data/seed."
            onConfirm={sync}
          >
            <Button type="primary" icon={<CloudSyncOutlined />} loading={syncing}>
              Sync từ Google Sheet
            </Button>
          </Popconfirm>
          <Typography.Text type="secondary">Company & GatewayCompanyMapping không có trong sheet → sửa trực tiếp ở đây.</Typography.Text>
        </Space>
      </Card>

      <Card>
        <Tabs
          destroyOnHidden
          items={[
            { key: "gateway", label: "GatewayCompanyMapping", children: <GatewayMappingTab /> },
            { key: "company", label: "Company", children: <CompanyTab /> },
            ...VIEW_TABLES.map((t) => ({ key: t.key, label: t.label, children: <ViewTab key={`${t.key}-${version}`} table={t} /> })),
          ]}
        />
      </Card>
    </Space>
  );
}

function ViewTab({ table }: { table: (typeof VIEW_TABLES)[number] }) {
  const [search, setSearch] = useState<string>();
  const [page, setPage] = useState({ page: 1, pageSize: 50 });
  const serverPaging = table.key === "partners";
  const list = useApi<{ rows: Record<string, unknown>[]; total: number }>(
    `/api/master/${table.key}${toQuery({ search, ...(serverPaging ? page : { pageSize: 5000 }) })}`,
  );
  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      {table.note && <Alert type="info" showIcon title={table.note} />}
      <Input.Search
        allowClear
        placeholder="Tìm kiếm"
        style={{ width: 300 }}
        onSearch={(v) => {
          setSearch(v);
          setPage({ ...page, page: 1 });
        }}
      />
      <Table
        size="small"
        rowKey={(r) => String(r[table.fields[0]])}
        loading={list.loading}
        dataSource={list.data?.rows}
        scroll={{ x: "max-content" }}
        columns={columnsOf<Record<string, unknown>>(table.fields)}
        pagination={
          serverPaging
            ? { current: page.page, pageSize: page.pageSize, total: list.data?.total, showSizeChanger: true, onChange: (p, s) => setPage({ page: p, pageSize: s }) }
            : { pageSize: 50, showTotal: (t) => `${t} dòng` }
        }
      />
    </Space>
  );
}

function GatewayMappingTab() {
  const { message } = App.useApp();
  const list = useApi<{ rows: GatewayCompanyMappingRow[] }>("/api/master/gatewayCompanyMapping");
  const companies = useApi<{ rows: CompanyRow[] }>("/api/master/company");
  const [editing, setEditing] = useState<Partial<GatewayCompanyMappingRow> | null>(null);
  const [form] = Form.useForm();

  const save = async () => {
    const values = await form.validateFields();
    try {
      await postJson("/api/master/gateway-mapping", { ...values, ID: editing?.ID, IsActive: values.IsActive ? 1 : 0 });
      message.success("Đã lưu. Build lại để áp dụng.");
      setEditing(null);
      await Promise.all([list.reload(), companies.reload()]);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <Alert type="info" showIcon title="PaymentGatewayName (cột trong file order) → ComCode (công ty ghi sổ). Gateway chưa map sẽ báo exception MISSING_COMCODE khi Build." />
      <Button
        icon={<PlusOutlined />}
        onClick={() => {
          setEditing({ IsActive: 1 });
        }}
      >
        Thêm mapping
      </Button>
      <Table
        size="small"
        rowKey="ID"
        loading={list.loading}
        dataSource={list.data?.rows}
        pagination={false}
        columns={[
          { title: "ID", dataIndex: "ID", width: 60 },
          { title: "PaymentGatewayName", dataIndex: "PaymentGatewayName" },
          { title: "ComCode", dataIndex: "ComCode" },
          { title: "IsActive", dataIndex: "IsActive", render: (v) => (v ? "✔" : "") },
          {
            title: "",
            width: 120,
            render: (_, r) => (
              <Space>
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => {
                    setEditing(r);
                  }}
                />
                <Popconfirm
                  title="Xóa mapping?"
                  onConfirm={async () => {
                    await deleteJson(`/api/master/gateway-mapping?id=${r.ID}`);
                    await list.reload();
                  }}
                >
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal open={!!editing} title={editing?.ID ? "Sửa mapping" : "Thêm mapping"} onCancel={() => setEditing(null)} onOk={save} destroyOnHidden>
        <Form form={form} layout="vertical" preserve={false} initialValues={{ ...editing, IsActive: !!editing?.IsActive }}>
          <Form.Item name="PaymentGatewayName" label="PaymentGatewayName (đúng như trong file order)" rules={[{ required: true }]}>
            <Input placeholder="VD: ZeniroxPay Inc." />
          </Form.Item>
          <Form.Item name="ComCode" label="ComCode (chọn hoặc gõ mã mới)" rules={[{ required: true }]}>
            <AutoComplete
              placeholder="VD: ZENIROXPAY"
              options={companies.data?.rows.map((c) => ({ value: c.ComCode, label: `${c.ComCode} – ${c.CompanyName ?? ""}` }))}
            />
          </Form.Item>
          <Form.Item name="IsActive" label="IsActive" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

function CompanyTab() {
  const { message } = App.useApp();
  const list = useApi<{ rows: CompanyRow[] }>("/api/master/company");
  const [editing, setEditing] = useState<Partial<CompanyRow> | null>(null);
  const [form] = Form.useForm();

  const save = async () => {
    const values = await form.validateFields();
    try {
      await postJson("/api/master/company", { ...values, IsActive: values.IsActive ? 1 : 0 });
      message.success("Đã lưu");
      setEditing(null);
      await list.reload();
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <Alert type="info" showIcon title="FunctionalCurrency = FncCurr khi ghi sổ. Khác InputCurr sẽ quy đổi theo bảng Exrate." />
      <Button
        icon={<PlusOutlined />}
        onClick={() => {
          setEditing({ FunctionalCurrency: "USD", IsActive: 1 });
        }}
      >
        Thêm công ty
      </Button>
      <Table
        size="small"
        rowKey="ComCode"
        loading={list.loading}
        dataSource={list.data?.rows}
        pagination={false}
        columns={[
          { title: "ComCode", dataIndex: "ComCode" },
          { title: "CompanyName", dataIndex: "CompanyName" },
          { title: "FunctionalCurrency", dataIndex: "FunctionalCurrency" },
          { title: "IsActive", dataIndex: "IsActive", render: (v) => (v ? "✔" : "") },
          {
            title: "",
            width: 60,
            render: (_, r) => (
              <Button
                size="small"
                icon={<EditOutlined />}
                onClick={() => {
                  setEditing(r);
                }}
              />
            ),
          },
        ]}
      />
      <Modal open={!!editing} title={editing?.ComCode ? `Sửa ${editing.ComCode}` : "Thêm công ty"} onCancel={() => setEditing(null)} onOk={save} destroyOnHidden>
        <Form form={form} layout="vertical" preserve={false} initialValues={{ ...editing, IsActive: !!editing?.IsActive }}>
          <Form.Item name="ComCode" label="ComCode" rules={[{ required: true }]}>
            <Input disabled={!!editing?.ComCode} />
          </Form.Item>
          <Form.Item name="CompanyName" label="CompanyName">
            <Input />
          </Form.Item>
          <Form.Item name="FunctionalCurrency" label="FunctionalCurrency" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="IsActive" label="IsActive" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
