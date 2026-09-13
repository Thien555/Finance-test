"use client";

import { QuestionCircleOutlined } from "@ant-design/icons";
import { DatePicker, Select, Space, type TableColumnType as ColumnType, Tag, Tooltip } from "antd";
import dayjs from "dayjs";
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
    } else if (["PostStatus", "Status", "BuildStatus", "Severity", "BalanceImpact", "Classify", "ItemStatus"].includes(name)) {
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
};

export function StatusTag({ value }: { value: string }) {
  return <Tag color={COLORS[value] ?? "default"}>{value}</Tag>;
}

export interface ScopeValue {
  comCode?: string;
  periodFrom?: string;
  periodTo?: string;
}

/** Chọn phạm vi: ComCode + khoảng kỳ */
export function ScopeBar({ value, onChange, options }: { value: ScopeValue; onChange: (v: ScopeValue) => void; options: FilterOptions | null }) {
  return (
    <Space wrap>
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
