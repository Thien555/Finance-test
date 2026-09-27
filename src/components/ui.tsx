"use client";

import { LockOutlined, QuestionCircleOutlined } from "@ant-design/icons";
import { Alert, DatePicker, Select, Space, type TableColumnType as ColumnType, Tag, Tooltip } from "antd";
import dayjs from "dayjs";
import Link from "next/link";
import type { FilterOptions } from "./client";
import { money } from "./client";

/** Header cột có tooltip giải thích */
export function FieldTitle({ name, docs }: { name: string; docs?: Record<string, string> }) {
  const doc = docs?.[name];
  if (!doc) return <>{name}</>;
  return (
    <Tooltip title={doc}>
      <span style={{ whiteSpace: "nowrap" }}>
        {name} <QuestionCircleOutlined style={{ color: "#8c8c8c", fontSize: 11 }} />
      </span>
    </Tooltip>
  );
}

const MONEY_FIELDS = new Set(["InputDr", "InputCr", "AccountedDr", "AccountedCr", "Amount", "UnitPrice", "ShippingFee", "TotalPrice", "Profit", "TaxFee", "AdditionalCost", "SupplierCost", "FulfillmentCost"]);

/** Sinh cột Table từ danh sách field, có tooltip + format tiền + tag trạng thái */
export function columnsOf<T extends object>(
  fields: string[],
  docs?: Record<string, string>,
  overrides: Record<string, Partial<ColumnType<T>>> = {},
): ColumnType<T>[] {
  return fields.map((name) => {
    const base: ColumnType<T> = {
      key: name,
      dataIndex: name,
      title: <FieldTitle name={name} docs={docs} />,
      ellipsis: ["Description", "PostingGroupKey", "SourceHash", "VariantName", "Domain", "Message", "ErrorMessage", "ErrorDetails"].includes(name),
      width: widthOf(name),
    };
    if (MONEY_FIELDS.has(name)) {
      base.align = "right";
      base.render = (v: number | null) => <span className="num">{money(v)}</span>;
    } else if (["PostStatus", "Status", "BuildStatus", "Severity", "BalanceImpact", "Classify", "ItemStatus", "Action", "FromStatus", "ToStatus"].includes(name)) {
      base.render = (v: string | null) => (v ? <StatusTag value={v} /> : null);
    }
    return { ...base, ...overrides[name] };
  });
}

function widthOf(name: string): number {
  if (["Description", "PostingGroupKey", "Message", "VariantName"].includes(name)) return 320;
  if (["TransactionID", "DocNum", "PartnerCode", "ErrorMessage", "SourceKey", "SellerEmail", "BuyerEmail", "Domain"].includes(name)) return 230;
  if (["JournalTypeCode", "ExceptionType", "SourceHash", "PartnerTaxID", "PartnerName", "ItemCode", "OrderID", "OrderId", "RefNum", "SourceID", "ReferenceTxnID", "PaymentGatewayName", "BuyerName"].includes(name)) return 210;
  if (name.endsWith("At") || name.endsWith("Date")) return 160;
  return 120;
}

const COLORS: Record<string, string> = {
  NEW: "blue",
  POSTED: "green",
  ERROR: "red",
  SKIPPED: "default",
  SUCCESS: "green",
  PARTIAL: "orange",
  FAILED: "red",
  RUNNING: "processing",
  UNPOSTED: "default",
  NOTHING_TO_POST: "default",
  BUILT: "green",
  NOT_BUILT: "blue",
  INFO: "default",
  WARNING: "orange",
  Debit: "geekblue",
  Credit: "purple",
  Single: "cyan",
  Bulk: "magenta",
  FULFILLED: "green",
  UNFULFILLED: "default",
  // Kỳ kế toán
  OPEN: "green",
  LOCKED: "red",
  LOCK: "volcano",
  UNLOCK: "cyan",
};

export function StatusTag({ value }: { value: string }) {
  return (
    <Tag color={COLORS[value] ?? "default"} icon={value === "LOCKED" ? <LockOutlined /> : undefined}>
      {value}
    </Tag>
  );
}

/** "ZENIROXPAY|202511" → "ZENIROXPAY 202511" */
const showLockKey = (key: string) => key.replace("|", " ");

/**
 * Cảnh báo "phần thuộc kỳ khóa sổ bị bỏ qua / giữ nguyên" cho kết quả Build / Post / Unpost / Unbuild / Import.
 * `periods`: khóa "COMCODE|YYYYMM"; `what`: VD "Build bỏ qua 12 event". Không có kỳ nào → không hiện gì.
 */
export function LockedPeriodsAlert({ periods, what }: { periods: string[] | null | undefined; what: string }) {
  if (!periods?.length) return null;
  const shown = periods.slice(0, 6).map(showLockKey).join(", ");
  const more = periods.length > 6 ? ` và ${periods.length - 6} kỳ khác` : "";
  return (
    <Alert
      type="warning"
      showIcon
      icon={<LockOutlined />}
      title={`${what} thuộc kỳ đã khóa sổ`}
      description={
        <span>
          {shown}
          {more}. Muốn thay đổi phần này: mở khóa ở trang <Link href="/periods">Kỳ kế toán</Link> (ghi lý do), chạy lại rồi khóa lại.
        </span>
      }
    />
  );
}

export interface ScopeValue {
  comCode?: string;
  periodFrom?: string;
  periodTo?: string;
  dataSource?: string;
}

/** Chọn phạm vi: nguồn dữ liệu + ComCode + khoảng kỳ */
export function ScopeBar({
  value,
  onChange,
  options,
  showDataSource = true,
}: {
  value: ScopeValue;
  onChange: (v: ScopeValue) => void;
  options: FilterOptions | null;
  /** Ẩn ô chọn nguồn ở màn hình chỉ có 1 nguồn */
  showDataSource?: boolean;
}) {
  return (
    <Space wrap>
      {showDataSource && (
        <Select
          allowClear
          placeholder="Nguồn (tất cả)"
          style={{ width: 200 }}
          value={value.dataSource}
          onChange={(dataSource) => onChange({ ...value, dataSource })}
          options={(options?.dataSources ?? []).map((v) => ({ value: v, label: v }))}
        />
      )}
      <Select
        allowClear
        placeholder="ComCode (tất cả)"
        style={{ width: 200 }}
        value={value.comCode}
        onChange={(comCode) => onChange({ ...value, comCode })}
        options={options?.comCodes.map((c) => ({ value: c.value, label: `${c.value}${c.label ? ` – ${c.label}` : ""}` }))}
      />
      <DatePicker.RangePicker
        picker="month"
        allowEmpty={[true, true]}
        placeholder={["Kỳ từ", "Kỳ đến"]}
        format="YYYYMM"
        value={[value.periodFrom ? dayjs(value.periodFrom, "YYYYMM") : null, value.periodTo ? dayjs(value.periodTo, "YYYYMM") : null]}
        onChange={(range) =>
          onChange({ ...value, periodFrom: range?.[0]?.format("YYYYMM") ?? undefined, periodTo: range?.[1]?.format("YYYYMM") ?? undefined })
        }
      />
    </Space>
  );
}
