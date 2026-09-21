"use client";

import {
  AlertOutlined,
  BookOutlined,
  CloudUploadOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  NodeIndexOutlined,
  SendOutlined,
} from "@ant-design/icons";
import { App, ConfigProvider, Layout, Menu, Typography } from "antd";
import viVN from "antd/locale/vi_VN";
import dayjs from "dayjs";
import "dayjs/locale/vi";
import Link from "next/link";
import { usePathname } from "next/navigation";

dayjs.locale("vi");

const MENU = [
  { key: "/", icon: <DashboardOutlined />, label: "Dashboard & luồng" },
  { key: "/raw/orders", icon: <CloudUploadOutlined />, label: "1. Raw Orders (Upload)" },
  { key: "/raw/paypal", icon: <CloudUploadOutlined />, label: "1b. Raw PayPal" },
  { key: "/raw/stripe", icon: <CloudUploadOutlined />, label: "1c. Raw Stripe" },
  { key: "/raw/pipo", icon: <CloudUploadOutlined />, label: "1d. Raw PIPO" },
  { key: "/raw/accounting-source", icon: <CloudUploadOutlined />, label: "1e. Raw AccountingSource" },
  { key: "/events", icon: <NodeIndexOutlined />, label: "2. AccountingEvent (Build)" },
  { key: "/posting", icon: <SendOutlined />, label: "3. Posting (PostingBatch)" },
  { key: "/gl", icon: <BookOutlined />, label: "4. GLTrans (Sổ cái)" },
  { key: "/exceptions", icon: <AlertOutlined />, label: "Exceptions" },
  { key: "/master", icon: <DatabaseOutlined />, label: "Master data" },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const selected = MENU.filter((m) => (m.key === "/" ? pathname === "/" : pathname.startsWith(m.key))).map((m) => m.key);

  return (
    <ConfigProvider locale={viVN} theme={{ token: { colorPrimary: "#1f6feb", borderRadius: 6 } }}>
      <App>
        <Layout style={{ minHeight: "100vh" }}>
          <Layout.Sider width={250} theme="light" breakpoint="lg" collapsedWidth={0} style={{ borderRight: "1px solid #f0f0f0" }}>
            <div style={{ padding: "18px 20px 10px" }}>
              <Typography.Title level={5} style={{ margin: 0 }}>
                Sky Finance
              </Typography.Title>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Accounting Engine
              </Typography.Text>
            </div>
            <Menu
              mode="inline"
              selectedKeys={selected}
              style={{ borderInlineEnd: 0 }}
              items={MENU.map((m) => ({ key: m.key, icon: m.icon, label: <Link href={m.key}>{m.label}</Link> }))}
            />
          </Layout.Sider>
          <Layout>
            <Layout.Content style={{ padding: 24, background: "#f5f7fa" }}>{children}</Layout.Content>
          </Layout>
        </Layout>
      </App>
    </ConfigProvider>
  );
}
