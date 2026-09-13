"use client";

import { FileAddOutlined, InboxOutlined, ReloadOutlined } from "@ant-design/icons";
import { App, Button, Card, Descriptions, Input, Select, Space, Table, Tabs, Typography, Upload } from "antd";
import { useMemo, useState } from "react";
import { postJson, toQuery, useApi, useOptions } from "@/components/client";
import { columnsOf, StatusTag } from "@/components/ui";
import type { ImportBatchRow, RawOrderRow } from "@/lib/db/schema";
import { ORDER_COLUMNS } from "@/lib/orders/columns";
import type { ImportOrdersResult } from "@/lib/services/import-orders";

const RAW_DOCS: Record<string, string> = {
  ComCode: "Resolve từ PaymentGatewayName qua Master → GatewayCompanyMapping.",
  BuildStatus: "NOT_BUILT = chưa build; BUILT = đã sinh event; SKIPPED = không đủ điều kiện (chưa fulfill); ERROR = thiếu mapping.",
  BuildMessage: "Lý do SKIPPED/ERROR.",
  ItemStatus: "Chỉ FULFILLED mới được ghi nhận doanh thu.",
  FulfilledAt: "Ngày fulfill → PostingDate & Period của event.",
  Quantity: "PRODUCT = Quantity × UnitPrice",
  UnitPrice: "PRODUCT = Quantity × UnitPrice",
  ShippingFee: "SHIPADD = ShippingFee + AdditionalCost",
  AdditionalCost: "SHIPADD = ShippingFee + AdditionalCost",
  TaxFee: "TAX = TaxFee",
  Profit: "SELLER_PROFIT = Profit (phải trả seller)",
  SellerEmail: "Map seller: Partners.PartnerCode (kèm StoreName nếu 1 email nhiều store).",
  TaxID: "Nếu có → map Partners.PartnerTaxID (ưu tiên cao nhất).",
  PaymentGatewayName: "Cổng thanh toán → ComCode.",
};

const FIRST = ["RawOrderID", "ImportBatchID", "ComCode", "BuildStatus", "BuildMessage", "OrderId", "ItemCode", "ItemStatus", "FulfilledAt", "Quantity", "UnitPrice", "ShippingFee", "AdditionalCost", "TaxFee", "Profit", "SellerEmail", "StoreName", "TaxID", "PaymentGatewayName"];
const FIELDS = [...FIRST, ...ORDER_COLUMNS.map(([n]) => n).filter((n) => !FIRST.includes(n))];

export default function RawOrdersPage() {
  const { message, modal } = App.useApp();
  const { data: options } = useOptions();
  const [filter, setFilter] = useState<{ search?: string; comCode?: string; itemStatus?: string; buildStatus?: string }>({});
  const [page, setPage] = useState({ page: 1, pageSize: 50 });
  const [uploading, setUploading] = useState(false);

  const orders = useApi<{ rows: RawOrderRow[]; total: number }>(`/api/orders${toQuery({ ...filter, ...page })}`);
  const batches = useApi<ImportBatchRow[]>("/api/import-batches");
  const columns = useMemo(() => columnsOf<RawOrderRow>(FIELDS, RAW_DOCS, { RawOrderID: { fixed: "left", width: 90 }, OrderId: { fixed: "left" } }), []);

  const showResult = (r: ImportOrdersResult) => {
    const content = (
      <Space orientation="vertical" style={{ width: "100%" }}>
        <Descriptions
          size="small"
          column={2}
          bordered
          items={[
            { label: "ImportBatchID", children: r.ImportBatchID },
            { label: "Status", children: <StatusTag value={r.Status} /> },
            { label: "Tổng dòng", children: r.TotalRows },
            { label: "Thêm mới", children: r.InsertedRows },
            { label: "Thay thế", children: r.ReplacedRows },
            { label: "Bỏ qua (không đổi)", children: r.SkippedRows },
            { label: "Lỗi", children: r.ErrorRows },
            { label: "Sheet", children: r.sheetName ?? "(CSV)" },
          ]}
        />
        {r.errors.length > 0 && (
          <Table
            size="small"
            rowKey={(e) => `${e.row}-${e.key}`}
            dataSource={r.errors}
            pagination={{ pageSize: 8 }}
            columns={[
              { title: "Dòng", dataIndex: "row", width: 60 },
              { title: "ItemCode", dataIndex: "key", width: 200 },
              { title: "Lỗi", dataIndex: "message" },
            ]}
          />
        )}
      </Space>
    );
    (r.ErrorRows ? modal.warning : modal.success)({ title: `Import ${r.FileName}`, content, width: 760 });
  };

  const refresh = async () => {
    await Promise.all([orders.reload(), batches.reload()]);
  };

  const importSample = async () => {
    setUploading(true);
    try {
      showResult(await postJson<ImportOrdersResult>("/api/orders/import-sample"));
      await refresh();
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <div>
        <Typography.Title level={3} style={{ marginBottom: 4 }}>
          1. Raw Orders
        </Typography.Title>
        <Typography.Text type="secondary">
          Upload file order thô (.csv hoặc .xlsx, header giống sheet order mẫu). Mỗi dòng = 1 item, khóa theo ItemCode. Import lại cùng file sẽ bỏ qua dòng
          không đổi.
        </Typography.Text>
      </div>

      <Card>
        <Upload.Dragger
          accept=".csv,.xlsx"
          multiple={false}
          showUploadList={false}
          disabled={uploading}
          customRequest={async ({ file, onSuccess, onError }) => {
            setUploading(true);
            try {
              const form = new FormData();
              form.append("file", file as File);
              const res = await fetch("/api/orders/import", { method: "POST", body: form });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
              onSuccess?.(data);
              showResult(data);
              await refresh();
            } catch (e) {
              onError?.(e as Error);
              message.error(e instanceof Error ? e.message : String(e));
            } finally {
              setUploading(false);
            }
          }}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">{uploading ? "Đang import..." : "Kéo thả hoặc bấm để chọn file order (.csv / .xlsx)"}</p>
          <p className="ant-upload-hint">Cột bắt buộc: OrderId, ItemCode, ItemStatus, Quantity, UnitPrice, PaymentGatewayName</p>
        </Upload.Dragger>
        <Space style={{ marginTop: 12 }}>
          <Button icon={<FileAddOutlined />} onClick={importSample} loading={uploading}>
            Import file order mẫu (64 dòng)
          </Button>
        </Space>
      </Card>

      <Card>
        <Tabs
          items={[
            {
              key: "rows",
              label: `Raw orders (${orders.data?.total ?? 0})`,
              children: (
                <Space orientation="vertical" style={{ width: "100%" }}>
                  <Space wrap>
                    <Input.Search
                      allowClear
                      placeholder="OrderId / ItemCode / Seller / Store"
                      style={{ width: 280 }}
                      onSearch={(search) => {
                        setFilter({ ...filter, search });
                        setPage({ ...page, page: 1 });
                      }}
                    />
                    <Select
                      allowClear
                      placeholder="ComCode"
                      style={{ width: 160 }}
                      options={options?.comCodes.map((c) => ({ value: c.value, label: c.value }))}
                      onChange={(comCode) => setFilter({ ...filter, comCode })}
                    />
                    <Select
                      allowClear
                      placeholder="ItemStatus"
                      style={{ width: 150 }}
                      options={["FULFILLED", "UNFULFILLED"].map((v) => ({ value: v, label: v }))}
                      onChange={(itemStatus) => setFilter({ ...filter, itemStatus })}
                    />
                    <Select
                      allowClear
                      placeholder="BuildStatus"
                      style={{ width: 150 }}
                      options={["NOT_BUILT", "BUILT", "SKIPPED", "ERROR"].map((v) => ({ value: v, label: v }))}
                      onChange={(buildStatus) => setFilter({ ...filter, buildStatus })}
                    />
                    <Button icon={<ReloadOutlined />} onClick={refresh} />
                  </Space>
                  <Table<RawOrderRow>
                    size="small"
                    rowKey="RawOrderID"
                    loading={orders.loading}
                    columns={columns}
                    dataSource={orders.data?.rows}
                    scroll={{ x: "max-content" }}
                    pagination={{
                      current: page.page,
                      pageSize: page.pageSize,
                      total: orders.data?.total,
                      showSizeChanger: true,
                      pageSizeOptions: [50, 100, 500],
                      onChange: (p, s) => setPage({ page: p, pageSize: s }),
                    }}
                  />
                </Space>
              ),
            },
            {
              key: "batches",
              label: "Lịch sử import (ImportBatch)",
              children: (
                <Table<ImportBatchRow>
                  size="small"
                  rowKey="ImportBatchID"
                  loading={batches.loading}
                  dataSource={batches.data ?? []}
                  scroll={{ x: "max-content" }}
                  columns={columnsOf<ImportBatchRow>(["ImportBatchID", "DataSource", "FileName", "UploadedAt", "Status", "TotalRows", "SuccessRows", "SkippedRows", "ErrorRows", "ErrorMessage"])}
                  expandable={{
                    rowExpandable: (r) => !!r.ErrorDetails,
                    expandedRowRender: (r) => (
                      <Table
                        size="small"
                        rowKey={(e: { row: number; key: string }) => `${e.row}-${e.key}`}
                        dataSource={JSON.parse(r.ErrorDetails ?? "[]")}
                        pagination={{ pageSize: 10 }}
                        columns={[
                          { title: "Dòng", dataIndex: "row", width: 60 },
                          { title: "ItemCode", dataIndex: "key", width: 220 },
                          { title: "Lỗi", dataIndex: "message" },
                        ]}
                      />
                    ),
                  }}
                />
              ),
            },
          ]}
        />
      </Card>
    </Space>
  );
}
