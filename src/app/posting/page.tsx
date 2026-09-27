"use client";

import { ReloadOutlined, RollbackOutlined, SendOutlined } from "@ant-design/icons";
import { Alert, App, Button, Card, Space, Table, Typography } from "antd";
import Link from "next/link";
import { useState } from "react";
import { postJson, useApi, useOptions } from "@/components/client";
import { columnsOf, LockedPeriodsAlert, type ScopeValue, ScopeBar, StatusTag } from "@/components/ui";
import type { PostingBatchRow } from "@/lib/db/schema";
import { POSTING_BATCH_FIELD_DOCS } from "@/lib/field-docs";
import type { UnpostResult } from "@/lib/services/clear";
import type { PostSummary } from "@/lib/services/post";

export default function PostingPage() {
  const { message, modal } = App.useApp();
  const { data: options, reload: reloadOptions } = useOptions();
  const [scope, setScope] = useState<ScopeValue>({});
  const [busy, setBusy] = useState<string | null>(null);
  const batches = useApi<PostingBatchRow[]>("/api/posting-batches");

  const post = async (classify: "Single" | "Bulk" | "All") => {
    setBusy(classify);
    try {
      const results = await postJson<PostSummary[]>("/api/post", { ...scope, classify });
      // Event NEW thuộc kỳ khóa sổ không được post (gộp Single + Bulk)
      const lockedEvents = results.reduce((a, r) => a + r.LockedEvents, 0);
      const lockedPeriods = [...new Set(results.flatMap((r) => r.LockedPeriods))].sort();
      modal.info({
        title: "Kết quả Post",
        width: 900,
        content: (
          <Space orientation="vertical" style={{ width: "100%" }}>
            <LockedPeriodsAlert periods={lockedPeriods} what={`Post bỏ qua ${lockedEvents} event`} />
            <Table
              size="small"
              pagination={false}
              rowKey="Classify"
              dataSource={results}
              columns={[
                { title: "Loại", dataIndex: "Classify", render: (v) => <StatusTag value={v} /> },
                { title: "PostBatchID", dataIndex: "PostBatchID" },
                { title: "Status", dataIndex: "Status", render: (v) => <StatusTag value={v} /> },
                { title: "Event NEW", dataIndex: "CandidateEvents" },
                { title: "POSTED", dataIndex: "PostedEvents" },
                { title: "Lỗi", dataIndex: "ErrorEvents" },
                { title: "Bỏ qua", dataIndex: "SkippedEvents" },
                { title: "Kỳ khóa (bỏ qua)", dataIndex: "LockedEvents" },
                { title: "Chứng từ", dataIndex: "Documents" },
                { title: "Dòng GL", dataIndex: "InsertedRows" },
                { title: "Lỗi hệ thống", dataIndex: "ErrorMessage" },
              ]}
            />
          </Space>
        ),
      });
      await Promise.all([batches.reload(), reloadOptions()]);
    } catch (e) {
      modal.error({ title: "Post lỗi", content: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const unpostFlow = async (postBatchId?: number) => {
    setBusy(postBatchId ? `unpost-${postBatchId}` : "unpost");
    try {
      const body = postBatchId ? { postBatchId } : scope;
      const p = await postJson<UnpostResult>("/api/unpost", { ...body, preview: true });
      if (p.events === 0) {
        if (p.lockedDocuments > 0) {
          message.warning(
            `Mọi chứng từ trong phạm vi thuộc kỳ đã khóa sổ (${p.lockedDocuments} chứng từ, ${p.lockedEvents} event) → không unpost. Muốn unpost: mở khóa kỳ ở trang Kỳ kế toán (ghi lý do).`,
          );
        } else {
          message.info("Không có event POSTED trong phạm vi");
        }
        return;
      }
      modal.confirm({
        title: postBatchId ? `Unpost batch #${postBatchId}?` : "Unpost theo phạm vi?",
        content: (
          <Space orientation="vertical">
            <span>
              Xóa {p.glLines} dòng GL ({p.documents} chứng từ), {p.events} event quay về NEW. Batch liên quan: {p.batches.join(", ")}
            </span>
            {p.lockedDocuments > 0 && (
              <LockedPeriodsAlert periods={p.lockedPeriods} what={`Giữ nguyên ${p.lockedDocuments} chứng từ (${p.lockedEvents} event)`} />
            )}
          </Space>
        ),
        okText: "Unpost",
        okButtonProps: { danger: true },
        onOk: async () => {
          await postJson("/api/unpost", body);
          message.success("Đã unpost");
          await batches.reload();
        },
      });
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const columns = [
    ...columnsOf<PostingBatchRow>(Object.keys(POSTING_BATCH_FIELD_DOCS), POSTING_BATCH_FIELD_DOCS),
    {
      key: "actions",
      title: "",
      fixed: "right" as const,
      width: 190,
      render: (_: unknown, r: PostingBatchRow) => (
        <Space>
          <Link href={`/gl?postBatchId=${r.PostBatchID}`}>Xem GL</Link>
          {r.Status === "SUCCESS" && r.InsertedRows > 0 && (
            <Button size="small" danger type="link" loading={busy === `unpost-${r.PostBatchID}`} onClick={() => unpostFlow(r.PostBatchID)}>
              Unpost batch
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <div>
        <Typography.Title level={3} style={{ marginBottom: 4 }}>
          3. Posting
        </Typography.Title>
        <Typography.Text type="secondary">Post chuyển AccountingEvent (NEW) thành dòng Nợ/Có trên GLTrans. Mỗi lần post 1 loại tạo 1 PostingBatch.</Typography.Text>
      </div>

      <Alert
        type="info"
        showIcon
        title="Single vs Bulk (theo JournalType.Classify)"
        description={
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>
              <b>Single</b>: mỗi event → 1 chứng từ 2 dòng, DocNum <span className="formula">ASI-yyyyMMdd-AccountingEventID</span> (PayPal chargeback, refund...).
            </li>
            <li>
              <b>Bulk</b>: gom event cùng <span className="formula">ComCode|JournalTypeCode|Ngày|InputCurr|FncCurr|Partner|TaxID|BankAccount</span> rồi cộng
              theo tài khoản, DocNum <span className="formula">ASB-yyyyMMdd-MinEventID</span>. Toàn bộ nghiệp vụ Orders là Bulk → post Single sẽ không có gì.
            </li>
          </ul>
        }
      />

      <Card title="Phạm vi & thao tác">
        <Space wrap>
          <ScopeBar value={scope} onChange={setScope} options={options} />
          <Button type="primary" icon={<SendOutlined />} loading={busy === "All"} onClick={() => post("All")}>
            Post tất cả (Single → Bulk)
          </Button>
          <Button loading={busy === "Single"} onClick={() => post("Single")}>
            Post Single
          </Button>
          <Button loading={busy === "Bulk"} onClick={() => post("Bulk")}>
            Post Bulk
          </Button>
          <Button danger icon={<RollbackOutlined />} loading={busy === "unpost"} onClick={() => unpostFlow()}>
            Unpost theo phạm vi
          </Button>
        </Space>
      </Card>

      <Card title="PostingBatch" extra={<Button icon={<ReloadOutlined />} onClick={batches.reload} />}>
        <Table<PostingBatchRow>
          size="small"
          rowKey="PostBatchID"
          loading={batches.loading}
          dataSource={batches.data ?? []}
          columns={columns}
          scroll={{ x: "max-content" }}
        />
      </Card>
    </Space>
  );
}
