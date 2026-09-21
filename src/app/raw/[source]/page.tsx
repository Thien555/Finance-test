"use client";

import { InboxOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, App, Button, Card, Descriptions, Input, Select, Space, Table, Tabs, Typography, Upload } from "antd";
import { notFound, useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { toQuery, useApi, useOptions } from "@/components/client";
import { columnsOf, StatusTag } from "@/components/ui";
import type { ImportBatchRow } from "@/lib/db/schema";
import type { ImportSourceResult } from "@/lib/services/import-source";
import { SOURCE_KEYS, SOURCE_META, type SourceKey } from "@/lib/sources/columns";

/** Cột quản trị chung của mọi bảng raw nguồn ngoài Orders */
const ADMIN_FIELDS = ["SourceKey", "ComCode", "PostingDate", "BuildStatus", "BuildMessage"];

const DOCS: Record<string, string> = {
  SourceKey: "Khóa định danh dòng. Không phụ thuộc các cột bạn điền tay, nên sửa tay rồi import lại vẫn nhận ra đúng dòng cũ.",
  PostingDate: "Ngày ghi sổ đã chuẩn hóa từ cột ngày của sheet — dùng để lọc theo kỳ khi Build.",
  BuildStatus: "NOT_BUILT = chưa build; BUILT = đã sinh event; SKIPPED = bị lọc bỏ; ERROR = thiếu mapping.",
  BuildMessage: "Lý do SKIPPED/ERROR, hoặc các rule bị bỏ qua của dòng này.",
  JournalType: "Cột bạn điền tay. Đây là JournalTypeCode và được ưu tiên; để trống thì engine suy từ loại giao dịch gốc.",
  PartnerCode: "Cột bạn điền tay. Dùng khi JournalType có Partner = From Source.",
  ComCode: "Cột bạn điền tay trên file. Phải có trong bảng Company.",
  BalanceImpact: "Debit = tiền ra khỏi tài khoản (Amount ghi âm); Credit = tiền vào (Amount ghi dương).",
  BankAccoutNumber: "Giữ đúng tên cột của sheet (thiếu chữ n). Để trống thì dùng tài khoản mặc định của nguồn.",
  ContraAccount: "Tài khoản đối ứng ghi thẳng trên dòng — thắng mặc định của JournalType.",
  TransAccount: "Tài khoản trung gian ghi thẳng trên dòng — thắng mặc định của JournalType.",
  SheetName: "Sheet gốc của dòng: Master Card hoặc Bank_Royal.",
};

export default function RawSourcePage() {
  const params = useParams<{ source: string }>();
  const source = params.source as SourceKey;
  if (!(SOURCE_KEYS as readonly string[]).includes(source)) notFound();

  return <RawSource source={source} />;
}

function RawSource({ source }: { source: SourceKey }) {
  const meta = SOURCE_META[source];
  const { message, modal } = App.useApp();
  const { data: options } = useOptions();
  const [filter, setFilter] = useState<{ search?: string; comCode?: string; buildStatus?: string; journalType?: string }>({});
  const [page, setPage] = useState({ page: 1, pageSize: 50 });
  const [sheet, setSheet] = useState(meta.sheets[0]);
  const [uploading, setUploading] = useState(false);

  const raw = useApi<{ rows: Record<string, unknown>[]; total: number; journalTypes: string[] }>(
    `/api/sources/${source}${toQuery({ ...filter, ...page })}`,
  );
  const batches = useApi<ImportBatchRow[]>("/api/import-batches");

  const fields = useMemo(() => {
    const sheetCols = meta.columns.map(([n]) => n);
    const known = new Set([...ADMIN_FIELDS, ...sheetCols, "SheetName"]);
    const primary = meta.primary.filter((n) => known.has(n));
    const rest = [...ADMIN_FIELDS, "SheetName", ...sheetCols].filter((n) => !primary.includes(n));
    return [...primary, ...new Set(rest)];
  }, [meta]);

  const columns = useMemo(
    () => columnsOf<Record<string, unknown>>(fields, DOCS, { SourceKey: { fixed: "left", width: 240 } }),
    [fields],
  );

  const showResult = (r: ImportSourceResult) => {
    const content = (
      <Space orientation="vertical" style={{ width: "100%" }}>
        <Descriptions
          size="small"
          column={2}
          bordered
          items={[
            { label: "ImportBatchID", children: r.ImportBatchID },
            { label: "Status", children: <StatusTag value={r.Status} /> },
            { label: "Sheet", children: r.sheetName ?? "(CSV)" },
            { label: "DataSource", children: r.DataSource },
            { label: "Tổng dòng", children: r.TotalRows },
            { label: "Thêm mới", children: r.InsertedRows },
            { label: "Thay thế", children: r.ReplacedRows },
            { label: "Bỏ qua (không đổi)", children: r.SkippedRows },
            { label: "Lỗi", children: r.ErrorRows },
          ]}
        />
        {r.errors.length > 0 && (
          <Table
            size="small"
            rowKey={(e) => `${e.row}-${e.key}`}
            dataSource={r.errors}
            pagination={{ pageSize: 8 }}
            columns={[
              { title: "Dòng", dataIndex: "row", width: 70 },
              { title: "SourceKey", dataIndex: "key", width: 240 },
              { title: "Lỗi", dataIndex: "message" },
            ]}
          />
        )}
      </Space>
    );
    (r.ErrorRows ? modal.warning : modal.success)({ title: `Import ${r.FileName}`, content, width: 800 });
  };

  const refresh = async () => {
    await Promise.all([raw.reload(), batches.reload()]);
  };

  return (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <div>
        <Typography.Title level={3} style={{ marginBottom: 4 }}>
          Raw {meta.label}
        </Typography.Title>
        <Typography.Text type="secondary">
          Upload sheet <b>{meta.sheets.join(" / ")}</b> của file Data-khac-order.xlsx (hoặc .csv tách riêng). DataSource ghi sổ:{" "}
          <b>{meta.dataSource}</b>.
        </Typography.Text>
      </div>

      <Alert
        type="info"
        showIcon
        title="Các cột điền tay"
        description="JournalType, StoreName, PartnerCode, ComCode do bạn điền trong Excel. Engine lấy cột JournalType làm chuẩn; để trống thì suy từ loại giao dịch gốc của nguồn. Sửa tay rồi import lại một dòng đã Build sẽ bị chặn — phải Unbuild nguồn đó trước."
      />

      <Card>
        {meta.sheets.length > 1 && (
          <Space style={{ marginBottom: 12 }}>
            <span>Sheet:</span>
            <Select value={sheet} style={{ width: 200 }} onChange={setSheet} options={meta.sheets.map((s) => ({ value: s, label: s }))} />
          </Space>
        )}
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
              form.append("sheet", sheet);
              const res = await fetch(`/api/sources/${source}/import`, { method: "POST", body: form });
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
          <p className="ant-upload-text">{uploading ? "Đang import..." : `Kéo thả hoặc bấm để chọn file — sẽ đọc sheet "${sheet}"`}</p>
          <p className="ant-upload-hint">Cột bắt buộc: {meta.required.join(", ")}</p>
        </Upload.Dragger>
      </Card>

      <Card>
        <Tabs
          items={[
            {
              key: "rows",
              label: `Dòng raw (${raw.data?.total ?? 0})`,
              children: (
                <Space orientation="vertical" style={{ width: "100%" }}>
                  <Space wrap>
                    <Input.Search
                      allowClear
                      placeholder="Mã giao dịch / Partner / Store"
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
                      showSearch
                      placeholder="JournalType"
                      style={{ width: 260 }}
                      options={(raw.data?.journalTypes ?? []).map((v) => ({ value: v, label: v }))}
                      onChange={(journalType) => setFilter({ ...filter, journalType })}
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
                  <Table<Record<string, unknown>>
                    size="small"
                    rowKey={(r) => String(r.SourceKey)}
                    loading={raw.loading}
                    columns={columns}
                    dataSource={raw.data?.rows}
                    scroll={{ x: "max-content" }}
                    pagination={{
                      current: page.page,
                      pageSize: page.pageSize,
                      total: raw.data?.total,
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
                  dataSource={(batches.data ?? []).filter((b) => b.DataSource === meta.dataSource)}
                  scroll={{ x: "max-content" }}
                  columns={columnsOf<ImportBatchRow>([
                    "ImportBatchID",
                    "DataSource",
                    "FileName",
                    "UploadedAt",
                    "Status",
                    "TotalRows",
                    "SuccessRows",
                    "SkippedRows",
                    "ErrorRows",
                    "ErrorMessage",
                  ])}
                  expandable={{
                    rowExpandable: (r) => !!r.ErrorDetails,
                    expandedRowRender: (r) => (
                      <Table
                        size="small"
                        rowKey={(e: { row: number; key: string }) => `${e.row}-${e.key}`}
                        dataSource={JSON.parse(r.ErrorDetails ?? "[]")}
                        pagination={{ pageSize: 10 }}
                        columns={[
                          { title: "Dòng", dataIndex: "row", width: 70 },
                          { title: "SourceKey", dataIndex: "key", width: 240 },
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
