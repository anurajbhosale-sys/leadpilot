import { submitLead } from "@/lib/leads";
import { leadFormSchema } from "@/lib/schemas";

// POST /api/leads: validate the form, then run the lead flow in lib/leads.ts.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = leadFormSchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors = Object.fromEntries(parsed.error.issues.map((i) => [i.path.join("."), i.message]));
    return Response.json({ error: "Invalid form", fieldErrors }, { status: 400 });
  }

  try {
    const result = await submitLead(parsed.data);
    return Response.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (err) {
    console.error("Lead submission failed:", err);
    return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
