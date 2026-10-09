// The consent-pdf job (D-17, C-07, TC-095): render the signed document, store it through the
// storage port at consents.pdf_key, and email the candidate a copy (template consent-copy).
// Idempotent and safe to run twice: each step is skipped once its column is set, and the columns
// are set by conditional updates, so two concurrent runs cannot both claim a step.
// The PDF lives outside the session prefix (ADR 0013 section 5.7): the consent proof keeps its own
// clock and is not deleted by an erasure of the session media.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import { consentPdfObjectKey } from '../media/storage-keys';
import { CandidateMailPort } from './candidate-mail.port';
import { renderConsentPdf } from './consent-pdf.renderer';
import { isDemoTextRefused } from './demo-consent';
import { ObjectStoragePort } from './object-storage.port';
import { newUlid } from './ulid';

@Injectable()
export class ConsentPdfService {
  private readonly logger = new Logger(ConsentPdfService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
    private readonly storage: ObjectStoragePort,
    private readonly mail: CandidateMailPort,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Returns false when there is nothing to do (no signed consent for this session in this org). */
  async generate(orgId: string, sessionId: string, now: Date = new Date()): Promise<boolean> {
    return this.orgContext.runInOrg(orgId, async () => {
      const consent = await this.prisma.client.consent.findUnique({
        where: { sessionId },
        select: {
          id: true,
          consentTextId: true,
          signedName: true,
          signedAt: true,
          ageConfirmedAt: true,
          pdfKey: true,
          copyEmailedAt: true,
        },
      });
      // The scoped client only finds this org's rows, so a job for another org finds nothing.
      if (!consent?.signedAt || !consent.signedName) return false;
      if (consent.pdfKey !== null && consent.copyEmailedAt !== null) return true;

      const [text, org, session] = await Promise.all([
        this.prisma.client.consentText.findUnique({
          where: { id: consent.consentTextId },
          select: { version: true, bodyMd: true, legalApprovedAt: true, legalApprovedBy: true },
        }),
        this.prisma.client.organization.findUnique({
          where: { id: orgId },
          select: { name: true },
        }),
        this.prisma.client.session.findUnique({
          where: { id: sessionId },
          select: { invitationId: true },
        }),
      ]);
      if (!text || !org || !session) return false;
      // A demo text in a shared env is never rendered, stored or emailed (K2/F6). The sweep may
      // queue the row again; the message is fixed text, no ids and no address.
      if (isDemoTextRefused(this.config, text)) {
        this.logger.warn('Consent PDF refused: demo consent text in a shared environment');
        return false;
      }

      const pdf = await renderConsentPdf({
        orgName: org.name,
        documentVersion: text.version,
        bodyMd: text.bodyMd,
        legalApproved: text.legalApprovedAt !== null,
        signedName: consent.signedName,
        signedAt: consent.signedAt,
        consentId: consent.id,
        sessionId,
        ageConfirmed: consent.ageConfirmedAt !== null,
      });

      if (consent.pdfKey === null) {
        const key = consentPdfObjectKey({ orgId, sessionId }, newUlid(now));
        await this.storage.putObject(key, pdf, 'application/pdf');
        const claimed = await this.prisma.client.consent.updateMany({
          where: { id: consent.id, pdfKey: null },
          data: { pdfKey: key, pdfGeneratedAt: now },
        });
        // A concurrent run stored its own copy first: remove ours so no orphan remains.
        if (claimed.count === 0) await this.storage.deleteObject(key);
      }

      if (consent.copyEmailedAt === null) {
        const invitation = await this.prisma.client.invitation.findUnique({
          where: { id: session.invitationId },
          select: { candidateId: true },
        });
        const candidate = invitation
          ? await this.prisma.client.candidate.findUnique({
              where: { id: invitation.candidateId },
              select: { email: true },
            })
          : null;
        if (candidate) {
          await this.mail.sendConsentCopy(candidate.email, {
            pdf,
            filename: `consent-${text.version.replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`,
            documentVersion: text.version,
            signedAt: consent.signedAt,
          });
          await this.prisma.client.consent.updateMany({
            where: { id: consent.id, copyEmailedAt: null },
            data: { copyEmailedAt: now },
          });
        } else {
          this.logger.error('Consent copy has no candidate address; not emailed');
        }
      }
      return true;
    });
  }
}
