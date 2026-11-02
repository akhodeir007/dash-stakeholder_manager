import { NextResponse } from "next/server";
import { runtimeDefaults } from "../../../config/runtime";

export function GET() {
  return NextResponse.json({
    status: runtimeDefaults.status,
    workflowReady: runtimeDefaults.workflowReady,
    integrations: { ...runtimeDefaults.integrations },
  });
}
