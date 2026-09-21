"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { Button, Card, Input, Select, Space, Table, Tag, Typography } from "antd";
import { useState } from "react";
import { toQuery, useApi, useOptions } from "@/components/client";
import { columnsOf } from "@/components/ui";
import type { ExceptionLogRow } from "@/lib/db/schema";

interface ExceptionList {
  rows: ExceptionLogRow[];
  total: number;
  byType: { BatchType: string; Severity: string; ExceptionType: string; Count: number }[];
}

const TYPE_DOCS: Record<string, string> = {
  NOT_FULFILLED: "Order chưa FULFILLED hoặc thiếu FulfilledAt → không ghi nhận (bình thường).",
  SOURCE_ROW_SKIPPED:
    "Dòng nguồn ngân hàng/PSP bị loại theo điều kiện của nguồn: PayPal/Stripe chỉ ghi sổ USD, PIPO chỉ ghi sổ Status = Success (bình thường).",
  INVALID_SOURCE_ROW: "Dòng nguồn thiếu dữ liệu bắt buộc để ghi sổ (không đọc được ngày, thiếu số tiền...) → sửa file rồi import lại.",
  UNKNOWN_AMOUNT_SOURCE: "JournalLineRule đòi một AmountSource mà nguồn này không có (VD rule dùng GROSS nhưng nguồn chỉ có AMOUNT).",
  AMOUNT_ZERO: "Số tiền = 0 và rule có SkipIfAmountZero → không tạo event (bình thường).",
  MISSING_COMCODE: "PaymentGatewayName chưa map ComCode → thêm ở Master → GatewayCompanyMapping rồi Build lại.",
  MISSING_COMPANY: "ComCode chưa có trong bảng Company.",
  MISSING_PARTNER:
    "Không tìm thấy đối tượng trong Partners (Orders: seller; nguồn ngân hàng/PSP: mã ở cột PartnerCode) → bổ sung Partners (Sync sheet) rồi Build lại. Với nguồn ngân hàng/PSP đây là cảnh báo: vẫn ghi sổ với mã đó nhưng PartnerTaxID trống.",
  MISSING_JOURNAL_TYPE:
    "Thiếu cấu hình JournalType. Với nguồn ngân hàng/PSP: mã ở cột JournalType bạn điền tay chưa có trong master (hoặc cột để trống mà loại giao dịch gốc cũng không map được) → thêm dòng JournalType rồi Build lại.",
  MISSING_RULE: "Thiếu JournalLineRule active.",
  MISSING_ACCOUNT:
    "Rule trỏ tới account trống trên JournalType. Với nguồn ngân hàng/PSP đây thường là bình thường: bộ 3 rule dùng chung, JournalType không khai TransAccount thì rule pair 2 tự bị bỏ.",
  ACCOUNT_NOT_IN_COA: "Tài khoản không có trong CoA.",
  MISSING_FX: "Thiếu tỷ giá trong Exrate cho kỳ/đồng tiền → bổ sung rồi Post lại.",
  NEGATIVE_AMOUNT: "Amount âm với NegativeMode = ERROR.",
  POSTED_SOURCE_CHANGED:
    "Event đã post nhưng dữ liệu nguồn/cấu hình đổi, hoặc lần Build này không còn sinh ra event đó (số tiền về 0, rule tắt, gateway mất mapping, đổi ngày giao) → Unpost + Build + Post lại nếu cần.",
  POSTED_KEY_CHANGED:
    "Item đã ghi sổ nhưng khóa event đổi (đổi GatewayCompanyMapping sang ComCode khác, đổi RuleSeq, đổi ngày giao...) → event mới bị giữ ERROR để không ghi sổ trùng. Unpost theo ComCode + kỳ cũ nêu trong message rồi Build (gồm cả kỳ/ComCode mới nếu message ghi) + Post lại; Build tự xóa event cũ không còn dòng nguồn.",
  DUPLICATE_ITEM:
    "Chốt chặn lúc Post: item của event đã ghi sổ (hoặc đang chờ post) ở event khác ngày giao / khác công ty, hoặc event tạo trước khi có cột ItemCodes → không post. Build lại (phạm vi gồm cả event kia) để đối chiếu rồi Post.",
};

export default function ExceptionsPage() {
  const { data: options } = useOptions();
  const [filter, setFilter] = useState<Record<string, string | undefined>>({});
  const [page, setPage] = useState({ page: 1, pageSize: 100 });
  const list = useApi<ExceptionList>(`/api/exceptions${toQuery({ ...filter, ...page })}`);
  const set = (patch: Record<string, string | undefined>) => {
    setFilter({ ...filter, ...patch });
    setPage({ ...page, page: 1 });
  };

  return (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <div>
        <Typography.Title level={3} style={{ marginBottom: 4 }}>
          Exceptions
        </Typography.Title>
        <Typography.Text type="secondary">Các dòng bị bỏ qua hoặc lỗi mapping khi Build/Post. INFO là bình thường; ERROR cần xử lý.</Typography.Text>
      </div>

      <Card title="Tổng hợp" size="small">
        <Table
          size="small"
          pagination={false}
          rowKey={(r) => `${r.BatchType}-${r.Severity}-${r.ExceptionType}`}
          dataSource={list.data?.byType}
          onRow={(r) => ({ onClick: () => set({ exceptionType: r.ExceptionType }), className: "clickable-row" })}
          columns={[
            { title: "Bước", dataIndex: "BatchType", width: 90 },
            { title: "Mức", dataIndex: "Severity", width: 100, render: (v) => <Tag color={v === "ERROR" ? "red" : v === "WARNING" ? "orange" : undefined}>{v}</Tag> },
            { title: "ExceptionType", dataIndex: "ExceptionType", width: 220 },
            { title: "Số lượng", dataIndex: "Count", width: 100, align: "right" },
            { title: "Ý nghĩa / cách xử lý", dataIndex: "ExceptionType", key: "doc", render: (v) => TYPE_DOCS[v] },
          ]}
        />
      </Card>

      <Card>
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Space wrap>
            <Select allowClear placeholder="Bước" style={{ width: 120 }} value={filter.batchType} options={["BUILD", "POST"].map((v) => ({ value: v, label: v }))} onChange={(batchType) => set({ batchType })} />
            <Select allowClear placeholder="Mức" style={{ width: 120 }} value={filter.severity} options={["ERROR", "WARNING", "INFO"].map((v) => ({ value: v, label: v }))} onChange={(severity) => set({ severity })} />
            <Select
              allowClear
              placeholder="ExceptionType"
              style={{ width: 240 }}
              value={filter.exceptionType}
              options={Object.keys(TYPE_DOCS).map((v) => ({ value: v, label: v }))}
              onChange={(exceptionType) => set({ exceptionType })}
            />
            <Select allowClear placeholder="ComCode" style={{ width: 160 }} value={filter.comCode} options={options?.comCodes.map((c) => ({ value: c.value, label: c.value }))} onChange={(comCode) => set({ comCode })} />
            <Input.Search allowClear placeholder="SourceKey / Message" style={{ width: 260 }} onSearch={(search) => set({ search })} />
            <Button icon={<ReloadOutlined />} onClick={list.reload} />
          </Space>
          <Table<ExceptionLogRow>
            size="small"
            rowKey="ID"
            loading={list.loading}
            dataSource={list.data?.rows}
            scroll={{ x: "max-content" }}
            columns={columnsOf<ExceptionLogRow>(["ID", "BatchType", "BatchID", "Severity", "ExceptionType", "ComCode", "Period", "SourceKey", "Message", "CreatedAt"], undefined, {
              Message: { ellipsis: false, width: 480 },
            })}
            pagination={{
              current: page.page,
              pageSize: page.pageSize,
              total: list.data?.total,
              showSizeChanger: true,
              onChange: (p, s) => setPage({ page: p, pageSize: s }),
            }}
          />
        </Space>
      </Card>
    </Space>
  );
}
